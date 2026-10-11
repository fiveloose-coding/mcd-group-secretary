#!/usr/bin/env node
/**
 * 麦麦拼单秘书 · 命令行入口
 * ------------------------------------------------------------------
 * 命令：
 *   doctor                        自检：验通 Token、服务器信息、可用工具
 *   stores --address-id <ID>      按配送地址查可用团餐门店
 *   menu   --store <编码> --be-code <编码>      打印门店菜单
 *   assist --store <编码> --be-code <编码>      打印可选助餐服务
 *   plan   --address-id <ID> --file <拼单文本> [--date "yyyy-MM-dd HH:mm"] [--json <输出路径>]
 *                                 生成拼单方案（只读，不下单）
 *
 * 环境变量：MCD_MCP_TOKEN —— 麦当劳 MCP Token（必填）
 *
 * 本命令**不会产生任何订单**：只用查询类工具与计价工具。
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { clientFromEnv, McpError } from "./mcd-client.mjs";
import { parseOrderSheet, OrderParseError } from "./order-parse.mjs";
import { matchItem } from "./menu-match.mjs";
import { splitBill } from "./bill-split.mjs";
import { compareScenarios } from "./savings.mjs";
import { formatCents, yuanToCents } from "./money.mjs";

/** 业务类型：1 到店自取 / 2 麦乐送到家 / 5 得来速 / 6 企业团餐 */
export const BE_TYPE = { pickup: 1, delivery: 2, driveThrough: 5, groupMeal: 6 };
/** 订单类型：1 到店（含自取与得来速） / 2 外送（含麦乐送与企业团餐） */
export const ORDER_TYPE = { pickup: 1, delivery: 2 };

/**
 * 常见「口头说法 -> 菜单名」别名表。
 * 只收录真实菜单里确实对不上的叫法，其余交给匹配算法。
 */
export const ALIASES = {
  可乐: "可口可乐",
  中可乐: "可口可乐",
  大可乐: "可口可乐",
  零度: "无糖可口可乐",
  零度可乐: "无糖可口可乐",
  无糖可乐: "无糖可口可乐",
  中薯: "薯条",
  大薯: "脆脆薯条",
  麦辣鸡腿堡: "麦辣鸡腿汉堡",
  板烧: "板烧鸡腿堡",
  巨无霸汉堡: "巨无霸",
};

/* ---------------------------------- 工具函数 ---------------------------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function requireArg(args, key) {
  const value = args[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`缺少必填参数 --${key}`);
  }
  return String(value);
}

/* --------------------------------- MCP 数据获取 -------------------------------- */

async function resolveStore(client, args) {
  if (args.store) {
    return {
      storeCode: String(args.store),
      beCode: args["be-code"] ? String(args["be-code"]) : undefined,
      storeName: "(命令行指定)",
      source: "cli",
    };
  }

  const addressId = requireArg(args, "address-id");
  const data = await client.callToolValue("delivery-query-stores", {
    beType: BE_TYPE.groupMeal,
    addressId,
  });
  const list = data?.data ?? [];
  if (list.length === 0) {
    throw new Error(`该配送地址下没有可用团餐门店（addressId=${addressId}）`);
  }
  const open = list.filter((s) => s.businessStatus !== false);
  const chosen = (open.length > 0 ? open : list)[0];
  return {
    storeCode: chosen.storeCode,
    beCode: chosen.beCode,
    storeName: chosen.storeName,
    businessHours: `${chosen.businessStartTime ?? "?"}-${chosen.businessEndTime ?? "?"}`,
    source: "delivery-query-stores",
    allStores: list.map((s) => ({ storeCode: s.storeCode, beCode: s.beCode, storeName: s.storeName })),
  };
}

async function fetchMenu(client, store) {
  const params = {
    storeCode: store.storeCode,
    orderType: ORDER_TYPE.delivery,
    beType: BE_TYPE.groupMeal,
  };
  if (store.beCode) params.beCode = store.beCode;

  const data = await client.callToolValue("query-meals", params);
  const meals = data?.data?.meals ?? {};
  const candidates = Object.entries(meals).map(([code, meal]) => ({
    code,
    name: meal.name,
    priceCents: yuanToCents(meal.currentPrice),
    canWithOrder: Boolean(meal.canWithOrder),
  }));
  if (candidates.length === 0) {
    throw new Error("门店菜单为空，无法生成方案");
  }
  return { candidates, categories: data?.data?.categories ?? [] };
}

async function fetchAssistance(client, store) {
  const params = {
    storeCode: store.storeCode,
    beType: BE_TYPE.groupMeal,
    orderType: ORDER_TYPE.delivery,
  };
  if (store.beCode) params.beCode = store.beCode;

  const data = await client.callToolValue("query-meal-assistance", params);
  return data?.data?.mealAssistanceItems ?? [];
}

async function priceOrder(client, store, items, { gmServiceCode, reservationDate }) {
  const params = {
    storeCode: store.storeCode,
    orderType: ORDER_TYPE.delivery,
    beType: BE_TYPE.groupMeal,
    items: items.map((line) => ({ productCode: line.code, quantity: line.qty })),
  };
  if (store.beCode) params.beCode = store.beCode;
  if (gmServiceCode) params.gmServiceCode = gmServiceCode;
  if (reservationDate) params.reservationDate = reservationDate;

  const payload = await client.callToolValue("calculate-price", params);
  // 麦当劳 MCP 的返回统一包了一层业务信封：{ success, code, message, data: {...} }
  if (payload && payload.success === false) {
    throw new Error(`[${payload.code}] ${payload.message ?? "calculate-price 业务失败"}`);
  }
  const data = payload?.data ?? payload;
  if (!data || typeof data.price !== "number") {
    throw new Error(payload?.message ?? "calculate-price 未返回 price 字段");
  }
  return data;
}

/* ----------------------------------- 渲染层 ----------------------------------- */

function renderReport({ store, order, matched, scenarioResult, bill, verification, assistanceTried }) {
  const lines = [];
  lines.push(`# 麦麦拼单方案`);
  lines.push("");
  lines.push(`- 门店：**${store.storeName}**（storeCode ${store.storeCode}${store.beCode ? ` / beCode ${store.beCode}` : ""}）`);
  lines.push(`- 场景：企业团餐（beType=6，外送）`);
  lines.push(`- 参与人：${order.participants.join("、")}（共 ${order.participants.length} 人）`);
  lines.push("");

  lines.push("## 菜品匹配");
  lines.push("");
  lines.push("| 拼单原话 | 匹配到菜单 SKU | 置信度 | 依据 |");
  lines.push("|---|---|---|---|");
  for (const m of matched) {
    const best = m.match.best;
    lines.push(
      `| ${m.label}${m.qty > 1 ? ` ×${m.qty}` : ""} | ${best ? `${best.name}（${best.code}）` : "**未命中**"} | ${
        best ? best.score.toFixed(2) : "-"
      } | ${m.match.source} |`,
    );
  }
  lines.push("");

  if (assistanceTried.length > 0) {
    lines.push("## 方案比价（同一张单，不同助餐服务）");
    lines.push("");
    lines.push("| 助餐服务 | 商品原价 | 配送费 | 打包费 | 优惠 | 实付 | 备注 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const s of assistanceTried) {
      if (!s.ok) {
        lines.push(`| ${s.label} | - | - | - | - | - | ⚠️ 不可用：${s.reason} |`);
        continue;
      }
      const d = s.data;
      const star = s.id === scenarioResult.best.id ? " ★最优" : "";
      lines.push(
        `| ${s.label} | ${formatCents(d.productOriginalPrice)} | ${formatCents(d.deliveryOriginalPrice)} | ${formatCents(
          d.packingOriginalPrice,
        )} | −${formatCents(d.discount)} | **${formatCents(d.price)}**${star} | |`,
      );
    }
    lines.push("");
    lines.push(
      `**最优方案：${scenarioResult.best.label}，实付 ${formatCents(scenarioResult.best.totalCents)}**` +
        `（相比基准 ${scenarioResult.baseline.label} 节省 ${formatCents(scenarioResult.savingVsBaselineCents)}）`,
    );
    if (scenarioResult.isTie) {
      lines.push("");
      lines.push(`> 说明：存在并列最优方案（${scenarioResult.tiedIds.join("、")}），已按方案 id 字典序取第一个。`);
    }
    lines.push("");
  }

  lines.push("## 账单分摊");
  lines.push("");
  for (const person of bill.perPerson) {
    lines.push(`### ${person.name} —— 应付 ${formatCents(person.totalCents)}`);
    lines.push("");
    lines.push("| 项目 | 单价小计 |");
    lines.push("|---|---|");
    for (const line of person.lines) {
      const suffix = line.shareCount > 1 ? `（${line.shareCount} 人均分）` : "";
      lines.push(`| ${line.label}${line.qty > 1 ? ` ×${line.qty}` : ""}${suffix} | ${formatCents(line.amountCents)} |`);
    }
    lines.push(`| 小计 | ${formatCents(person.subtotalCents)} |`);
    if (person.discountCents > 0) lines.push(`| 优惠分摊 | −${formatCents(person.discountCents)} |`);
    if (person.surchargeCents > 0) lines.push(`| 配送/打包费分摊 | +${formatCents(person.surchargeCents)} |`);
    lines.push(`| **应付** | **${formatCents(person.totalCents)}** |`);
    lines.push("");
  }

  lines.push("## 汇总与校验");
  lines.push("");
  lines.push(`- 商品小计：${formatCents(bill.subtotalCents)}`);
  lines.push(`- 优惠：−${formatCents(bill.discountCents)}`);
  lines.push(`- 配送 + 打包费：+${formatCents(bill.surchargeCents)}`);
  lines.push(`- **实付合计：${formatCents(bill.totalCents)}**`);
  lines.push(`- 各人应付之和：${formatCents(bill.invariants.sumOfTotals)}（分摊不变量：${bill.invariants.sumOfTotalsEqualsGrandTotal ? "✅ 通过" : "❌ 失败"}）`);
  lines.push(
    `- 与 MCP 权威计价交叉核对：${verification.matchesAuthority ? "✅ 完全一致" : `⚠️ 不一致（本地推算 ${formatCents(verification.computedCents)} vs 权威 ${formatCents(verification.authorityCents)}）`}`,
  );
  lines.push("");
  lines.push("> 本方案为**只读结果**，未创建任何订单。下单需要人工确认后单独执行。");

  if (bill.warnings.length > 0) {
    lines.push("");
    lines.push("### 提示");
    for (const w of bill.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}

/* ----------------------------------- 各命令 ----------------------------------- */

async function cmdDoctor(client) {
  const info = await client.initialize();
  const tools = await client.listTools();
  const names = tools.map((t) => t.name);
  const required = [
    "query-meals",
    "query-meal-assistance",
    "calculate-price",
    "query-promotions",
    "delivery-query-stores",
    "delivery-query-addresses",
  ];
  const missing = required.filter((n) => !names.includes(n));

  console.log("麦当劳 MCP 自检");
  console.log("──────────────────────────────────────────");
  console.log("服务端：      ", info?.serverInfo?.name, info?.serverInfo?.version);
  console.log("协议版本：    ", info?.protocolVersion);
  console.log("会话 ID：     ", client.sessionId ? "已建立" : "未返回（部分实现可省略）");
  console.log("工具总数：    ", names.length);
  console.log("本流程必需工具：", missing.length === 0 ? "全部可用 ✅" : `缺失 ${missing.join(", ")} ❌`);
  console.log("──────────────────────────────────────────");
  return missing.length === 0 ? 0 : 1;
}

async function cmdStores(client, args) {
  const addressId = requireArg(args, "address-id");
  const data = await client.callToolValue("delivery-query-stores", {
    beType: Number(args["be-type"] ?? BE_TYPE.groupMeal),
    addressId,
  });
  const list = data?.data ?? [];
  console.log(`该地址可用门店 ${list.length} 家：\n`);
  for (const s of list) {
    console.log(`- ${s.storeName}`);
    console.log(`  storeCode=${s.storeCode}  beCode=${s.beCode}  营业 ${s.businessStartTime}-${s.businessEndTime}  营业中=${s.businessStatus}`);
  }
  return 0;
}

async function cmdMenu(client, args) {
  const store = { storeCode: requireArg(args, "store"), beCode: args["be-code"] ? String(args["be-code"]) : undefined };
  const { candidates, categories } = await fetchMenu(client, store);
  console.log(`门店 ${store.storeCode} 团餐菜单（${candidates.length} 项）\n`);
  for (const c of candidates) {
    console.log(`${c.code}\t${formatCents(c.priceCents)}\t${c.name}`);
  }
  if (categories.length > 0) {
    console.log("\n分类：", categories.map((c) => c.name).join("、"));
  }
  return 0;
}

async function cmdAssist(client, args) {
  const store = { storeCode: requireArg(args, "store"), beCode: args["be-code"] ? String(args["be-code"]) : undefined };
  const list = await fetchAssistance(client, store);
  console.log(`门店 ${store.storeCode} 助餐服务（${list.length} 档）\n`);
  for (const a of list) {
    console.log(`- ${a.gmServiceCode} ${a.gmServiceName}  可启用=${a.enable ? "是" : "否"}`);
    console.log(`  服务内容：${(a.serviceItems ?? []).join(" / ")}`);
    if (a.unusableReason) console.log(`  不可用原因：${a.unusableReason}`);
  }
  return 0;
}

async function cmdPlan(client, args) {
  const file = requireArg(args, "file");
  const reservationDate = args.date ? String(args.date) : undefined;

  const text = readFileSync(file, "utf8");
  const order = parseOrderSheet(text);

  const store = await resolveStore(client, args);
  const { candidates } = await fetchMenu(client, store);

  // 1) 菜名匹配（纯函数）
  const matched = order.items.map((item) => ({
    ...item,
    match: matchItem(item.label, candidates, { aliases: ALIASES }),
  }));

  const unmatched = matched.filter((m) => !m.match.matched);
  if (unmatched.length > 0) {
    console.error("以下条目无法在门店菜单中找到对应餐品，**不做猜测**，请修改拼单文本：\n");
    for (const m of unmatched) {
      console.error(`- 第 ${m.line} 行「${m.label}」`);
      if (m.match.alternatives.length > 0) {
        console.error(`  最接近的候选：${m.match.alternatives.map((a) => `${a.name}(${a.score.toFixed(2)})`).join("、")}`);
      }
    }
    return 2;
  }

  const orderLines = matched.map((m) => ({
    code: m.match.best.code,
    name: m.match.best.name,
    unitPriceCents: candidates.find((c) => c.code === m.match.best.code).priceCents,
    qty: m.qty,
    owners: m.owners,
  }));

  // 2) 逐档助餐服务取权威价格（纯只读）
  const assistance = await fetchAssistance(client, store);
  const tried = [];
  for (const service of assistance) {
    const label = `${service.gmServiceName}（${service.gmServiceCode}）`;
    if (!service.enable && !reservationDate) {
      tried.push({ id: service.gmServiceCode, label, ok: false, reason: service.unusableReason ?? "当前不可启用" });
      continue;
    }
    try {
      const data = await priceOrder(client, store, orderLines, {
        gmServiceCode: service.gmServiceCode,
        reservationDate,
      });
      tried.push({
        id: service.gmServiceCode,
        label,
        ok: true,
        totalCents: data.price,
        data,
        note: data.enjoyable ? `enjoyable=${JSON.stringify(data.enjoyable)}（语义未定义，仅展示）` : undefined,
      });
    } catch (err) {
      tried.push({ id: service.gmServiceCode, label, ok: false, reason: err.message });
    }
  }

  const okScenarios = tried.filter((t) => t.ok);
  if (okScenarios.length === 0) {
    console.error("所有助餐服务档位均计价失败，无法生成方案：");
    for (const t of tried) console.error(`- ${t.label}：${t.reason}`);
    return 3;
  }

  // 3) 比价（纯函数）
  const scenarioResult = compareScenarios(
    okScenarios.map((s) => ({ id: s.id, label: s.label, totalCents: s.totalCents })),
  );
  const best = okScenarios.find((s) => s.id === scenarioResult.best.id);

  // 4) 分摊（纯函数）——配送费与打包费按人头均分
  const bill = splitBill({
    participants: order.participants,
    items: orderLines.map((l) => ({
      label: l.name,
      unitPriceCents: l.unitPriceCents,
      qty: l.qty,
      owners: l.owners,
    })),
    discountCents: best.data.discount,
    surchargeCents: best.data.deliveryOriginalPrice + best.data.packingOriginalPrice,
    surchargeAllocation: "equal",
  });

  const verification = {
    matchesAuthority: bill.totalCents === best.data.price,
    computedCents: bill.totalCents,
    authorityCents: best.data.price,
    lineSumMatchesProductOriginal: bill.subtotalCents === best.data.productOriginalPrice,
    productOriginalAuthorityCents: best.data.productOriginalPrice,
  };

  const report = renderReport({ store, order, matched, scenarioResult, bill, verification, assistanceTried: tried });
  console.log(report);

  if (args.json) {
    const payload = {
      generatedAt: new Date().toISOString(),
      store,
      order,
      matched: matched.map((m) => ({ label: m.label, qty: m.qty, owners: m.owners, match: m.match })),
      scenarios: tried,
      bestScenarioId: scenarioResult.best.id,
      bill,
      verification,
    };
    writeFileSync(String(args.json), JSON.stringify(payload, null, 2), "utf8");
    console.log(`\n（结构化结果已写入 ${args.json}）`);
  }

  if (bill.warnings.length > 0) return 0;
  return verification.matchesAuthority ? 0 : 4;
}

/* ------------------------------------ main ----------------------------------- */

const USAGE = `麦麦拼单秘书

用法：
  node src/group-secretary.mjs doctor
  node src/group-secretary.mjs stores --address-id <配送地址ID> [--be-type 6]
  node src/group-secretary.mjs menu   --store <门店编码> [--be-code <业务编码>]
  node src/group-secretary.mjs assist --store <门店编码> [--be-code <业务编码>]
  node src/group-secretary.mjs plan   --address-id <ID> --file <拼单文本> [--date "yyyy-MM-dd HH:mm"] [--json <输出路径>]

环境变量：
  MCD_MCP_TOKEN   麦当劳 MCP Token（必填）
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || command === "help" || args.help) {
    console.log(USAGE);
    return 0;
  }

  const client = clientFromEnv();
  await client.initialize();

  switch (command) {
    case "doctor":
      return cmdDoctor(client);
    case "stores":
      return cmdStores(client, args);
    case "menu":
      return cmdMenu(client, args);
    case "assist":
      return cmdAssist(client, args);
    case "plan":
      return cmdPlan(client, args);
    default:
      console.error(`未知命令：${command}\n`);
      console.log(USAGE);
      return 64;
  }
}

main().catch((err) => {
  if (err instanceof OrderParseError) {
    console.error(`拼单文本解析失败：${err.message}`);
  } else if (err instanceof McpError) {
    console.error(`麦当劳 MCP 调用失败：${err.message}`);
  } else {
    console.error(`执行失败：${err.message}`);
  }
  process.exit(1);
});
