/**
 * 省钱方案比价（纯函数）
 * ------------------------------------------------------------------
 * 本项目**不自己计算优惠**——优惠后的价格一律由 MCP `calculate-price` 返回。
 * 本模块只负责一件确定的事：把多个候选场景的「权威总价」放在一起比大小，
 * 选出最优方案并给出可解释的差额。
 */

import { assertCents } from "./money.mjs";

/**
 * @param {Array<{id:string,label:string,totalCents:number,note?:string}>} scenarios
 *        候选方案（其中应包含一个 id 为 baseline 的「不使用任何优惠」基准方案）
 * @param {object} [opts]
 * @param {string} [opts.baselineId] 基准方案 id，默认 "baseline"
 */
export function compareScenarios(scenarios, { baselineId = "baseline" } = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new TypeError("至少需要一个候选方案");
  }
  for (const s of scenarios) {
    if (!s || typeof s.id !== "string" || s.id === "") {
      throw new TypeError("每个方案都必须有非空字符串 id");
    }
    assertCents(s.totalCents, `方案「${s.id}」的总价`);
    if (s.totalCents < 0) {
      throw new TypeError(`方案「${s.id}」总价为负：${s.totalCents}`);
    }
  }

  const sorted = [...scenarios].sort((a, b) => {
    if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  // 基准方案缺失时，退化为「最贵的那个方案」作为参照，并在返回值中标明来源
  const explicitBaseline = scenarios.find((s) => s.id === baselineId);
  const baseline = explicitBaseline ?? worst;

  const tiedIds = sorted.filter((s) => s.totalCents === best.totalCents).map((s) => s.id);

  return {
    best,
    sorted,
    baseline,
    baselineSource: explicitBaseline ? "explicit" : "fallback-worst",
    savingVsBaselineCents: baseline.totalCents - best.totalCents,
    savingVsWorstCents: worst.totalCents - best.totalCents,
    tiedIds,
    isTie: tiedIds.length > 1,
  };
}
