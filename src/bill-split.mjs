/**
 * 账单分摊（纯函数）
 * ------------------------------------------------------------------
 * 这是本项目最需要「算得死」的部分：钱分错了比功能少了更严重。
 *
 * 三条硬规则：
 *   R1 全程整数「分」运算，不出现浮点金额；
 *   R2 均分有余数时，按参与人**给定顺序**逐分发放（确定性，可复现）；
 *   R3 每次分摊后校验不变量 Σ个人应付 === 小计 − 折扣，不成立立即抛错。
 *
 * 支持两类常见拼单形态：
 *   - 独占条目：owners 只有一个人；
 *   - 共享条目：owners 有多个人，按人头均分（例如「大薯条 @张三 @李四」）。
 */

import { assertCents } from "./money.mjs";

/**
 * 按权重把一笔整数金额分配成整数数组，**和严格等于 totalCents**。
 * 算法：先按 floor(total * w/W) 分配，剩余的分按「小数部分降序，其次下标升序」逐个发放。
 */
export function allocateByWeights(totalCents, weights) {
  assertCents(totalCents, "待分配金额");
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new TypeError("权重数组不能为空");
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new TypeError("权重必须是非负有限数");
  }

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    throw new TypeError("权重之和不能为 0（无法分摊）");
  }

  const exact = weights.map((w) => (totalCents * w) / totalWeight);
  const base = exact.map((v) => Math.floor(v));
  let remainder = totalCents - base.reduce((sum, v) => sum + v, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction !== a.fraction ? b.fraction - a.fraction : a.index - b.index));

  const result = base.slice();
  let cursor = 0;
  while (remainder > 0) {
    result[order[cursor % order.length].index] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return result;
}

/**
 * 生成一张分账单。
 *
 * @param {object} input
 * @param {string[]} input.participants 参与人姓名（顺序决定余数分配顺序）
 * @param {Array<{label:string, unitPriceCents:number, qty?:number, owners?:string[]}>} input.items
 * @param {number} [input.discountCents] 门店总优惠（正数表示减免）
 * @param {number} [input.surchargeCents] 需额外加收的金额（如配送费 + 打包费），正数表示加价
 * @param {"proportional"|"equal"} [input.surchargeAllocation] 附加费分摊方式：
 *        proportional（默认，按各人小计比例）或 equal（按人头均分，团餐配送费通常用这个）
 * @returns 分账明细 + 汇总 + 不变量校验结果
 */
export function splitBill({
  participants,
  items,
  discountCents = 0,
  surchargeCents = 0,
  surchargeAllocation = "proportional",
}) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new TypeError("参与人列表不能为空");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError("条目列表不能为空");
  }
  assertCents(discountCents, "优惠金额");
  assertCents(surchargeCents, "附加费用");

  const warnings = [];
  const names = [...participants];
  const subtotal = new Map(names.map((n) => [n, 0]));
  const detail = new Map(names.map((n) => [n, []]));

  for (const item of items) {
    const owners = item.owners && item.owners.length > 0 ? item.owners : names;
    for (const owner of owners) {
      if (!names.includes(owner)) {
        throw new TypeError(`条目「${item.label}」的归属人「${owner}」不在参与人列表中`);
      }
    }

    const qty = item.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1) {
      throw new TypeError(`条目「${item.label}」数量非法：${qty}`);
    }
    assertCents(item.unitPriceCents, `条目「${item.label}」单价`);

    const amount = item.unitPriceCents * qty;
    const shares = allocateByWeights(amount, owners.map(() => 1));

    owners.forEach((owner, index) => {
      subtotal.set(owner, subtotal.get(owner) + shares[index]);
      detail.get(owner).push({
        label: item.label,
        qty,
        shareCount: owners.length,
        amountCents: shares[index],
      });
    });
  }

  const subtotalCents = [...subtotal.values()].reduce((sum, v) => sum + v, 0);

  // 折扣不能超过小计；超出则截断并记 warning（不静默吞掉）
  let appliedDiscount = discountCents;
  if (discountCents > subtotalCents) {
    appliedDiscount = subtotalCents;
    warnings.push(
      `优惠金额 ${discountCents} 分大于小计 ${subtotalCents} 分，已按小计截断（不会出现负数账单）。`,
    );
  }
  if (discountCents < 0) {
    throw new TypeError("优惠金额不能为负数");
  }

  const grandTotalCents = subtotalCents - appliedDiscount + surchargeCents;

  // 折扣与附加费按各人小计比例分摊；小计全为 0 时按人头均分
  const weights = names.map((n) => subtotal.get(n));
  const weightSum = weights.reduce((sum, v) => sum + v, 0);
  const effectiveWeights = weightSum === 0 ? names.map(() => 1) : weights;

  if (surchargeAllocation !== "proportional" && surchargeAllocation !== "equal") {
    throw new TypeError(
      `surchargeAllocation 只能是 proportional 或 equal，收到：${surchargeAllocation}`,
    );
  }
  const surchargeWeights = surchargeAllocation === "equal" ? names.map(() => 1) : effectiveWeights;

  const discountShares =
    appliedDiscount === 0 ? names.map(() => 0) : allocateByWeights(appliedDiscount, effectiveWeights);
  const surchargeShares =
    surchargeCents === 0 ? names.map(() => 0) : allocateByWeights(surchargeCents, surchargeWeights);

  const perPerson = names.map((name, index) => {
    const personSubtotal = subtotal.get(name);
    const personDiscount = discountShares[index];
    const personSurcharge = surchargeShares[index];
    return {
      name,
      subtotalCents: personSubtotal,
      discountCents: personDiscount,
      surchargeCents: personSurcharge,
      totalCents: personSubtotal - personDiscount + personSurcharge,
      lines: detail.get(name),
    };
  });

  const sumOfTotals = perPerson.reduce((sum, p) => sum + p.totalCents, 0);
  if (sumOfTotals !== grandTotalCents) {
    throw new Error(
      `分摊不变量被破坏：Σ个人应付 ${sumOfTotals} 分 ≠ 实付 ${grandTotalCents} 分（这是代码缺陷，不是数据问题）`,
    );
  }

  return {
    perPerson,
    subtotalCents,
    discountCents: appliedDiscount,
    surchargeCents,
    totalCents: grandTotalCents,
    warnings,
    invariants: { sumOfTotalsEqualsGrandTotal: true, sumOfTotals },
  };
}
