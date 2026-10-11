/**
 * 菜名 -> 菜单 SKU 的确定性匹配（纯函数）
 * ------------------------------------------------------------------
 * 目标：把「群里说的名字」对上「菜单上真实的 SKU」，并且**结果可解释、可复现**。
 *
 * 匹配规则按优先级自上而下，命中即返回该级别得分：
 *   R1 精确：归一化后完全相等                     -> 1.00  source=exact
 *   R2 别名：命中调用方传入的别名表（用户说法→菜单名） -> 1.00  source=alias
 *   R3 包含：一方是另一方的子串                   -> 0.75 + 0.25 * 短/长   source=contains
 *   R4 相似：字符二元组 Dice 系数                 -> dice  source=fuzzy
 *
 * 低于 `threshold`（默认 0.45）判定为**未命中**，此时不猜，而是返回
 * `{ matched:false, alternatives:[...] }` 交给人工或上游 Agent 决策。
 *
 * 排序确定性：得分降序 -> 菜单名长度升序 -> 菜单名字典序升序（普通字符串比较，
 * 不使用 locale 排序，避免不同运行环境结果不一致）。
 */

/** 归一化：全角转半角、去空白、去中英文标点、转小写 */
export function normalizeName(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/g, "")
    .replace(/[、。，．：；！？（）【】《》「」『』·—～…“”‘’]/g, "");
}

/** 字符二元组 */
function bigrams(text) {
  const chars = [...text];
  if (chars.length <= 1) return chars.length === 1 ? [chars[0]] : [];
  const out = [];
  for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** Dice 系数（多重集版本，正确处理重复二元组） */
export function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return a === b ? 1 : 0;

  const pool = new Map();
  for (const gram of A) pool.set(gram, (pool.get(gram) ?? 0) + 1);

  let hit = 0;
  for (const gram of B) {
    const left = pool.get(gram) ?? 0;
    if (left > 0) {
      hit += 1;
      pool.set(gram, left - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/** 统一排序：得分降序 -> 名称长度升序 -> 名称字典序升序 */
function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.item.name.length !== b.item.name.length) {
    return a.item.name.length - b.item.name.length;
  }
  if (a.item.name < b.item.name) return -1;
  if (a.item.name > b.item.name) return 1;
  return 0;
}

/**
 * @param {string} query 用户写法的菜名
 * @param {Array<{code:string,name:string}>} candidates 菜单 SKU 列表
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.aliases] 别名表：用户说法 -> 菜单名
 * @param {number} [opts.threshold] 命中阈值
 * @param {number} [opts.limit] alternatives 返回条数
 */
export function matchItem(query, candidates, opts = {}) {
  const { aliases = {}, threshold = 0.45, limit = 3 } = opts;

  const q = normalizeName(query);
  if (!q) {
    return { query, matched: false, score: 0, source: "empty", best: null, alternatives: [] };
  }

  const pool = candidates
    .filter((c) => c && c.name)
    .map((c) => ({ item: c, normalized: normalizeName(c.name) }));

  const scored = [];

  for (const entry of pool) {
    // R1 精确
    if (entry.normalized === q) {
      scored.push({ item: entry.item, score: 1, source: "exact" });
      continue;
    }

    // R2 别名：别名表的 key 归一化后等于查询，取其目标菜单名
    let aliasMatched = false;
    for (const [spoken, canonical] of Object.entries(aliases)) {
      if (normalizeName(spoken) !== q) continue;
      if (entry.normalized === normalizeName(canonical)) {
        scored.push({ item: entry.item, score: 1, source: "alias" });
        aliasMatched = true;
        break;
      }
    }
    if (aliasMatched) continue;

    // R3 包含
    if (entry.normalized.includes(q) || q.includes(entry.normalized)) {
      const shorter = Math.min(entry.normalized.length, q.length);
      const longer = Math.max(entry.normalized.length, q.length);
      const score = 0.75 + 0.25 * (shorter / longer);
      scored.push({ item: entry.item, score, source: "contains" });
      continue;
    }

    // R4 二元组相似度
    const dice = diceCoefficient(entry.normalized, q);
    if (dice > 0) {
      scored.push({ item: entry.item, score: dice, source: "fuzzy" });
    }
  }

  scored.sort(compareCandidates);

  const top = scored[0];
  const matched = Boolean(top) && top.score >= threshold;

  return {
    query,
    matched,
    score: top ? Number(top.score.toFixed(4)) : 0,
    source: matched ? top.source : "below-threshold",
    best: matched
      ? { code: top.item.code, name: top.item.name, score: Number(top.score.toFixed(4)), source: top.source }
      : null,
    alternatives: scored
      .slice(matched ? 1 : 0, (matched ? 1 : 0) + limit)
      .map((s) => ({ code: s.item.code, name: s.item.name, score: Number(s.score.toFixed(4)), source: s.source })),
  };
}

/** 批量匹配：返回逐条结果与汇总统计 */
export function matchAll(queries, candidates, opts = {}) {
  const results = queries.map((query) => matchItem(query, candidates, opts));
  const hit = results.filter((r) => r.matched).length;
  return {
    results,
    summary: { total: results.length, matched: hit, unmatched: results.length - hit },
  };
}
