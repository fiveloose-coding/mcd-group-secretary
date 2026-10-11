import test from "node:test";
import assert from "node:assert/strict";

import { compareScenarios } from "../src/savings.mjs";

test("比价：选出总价最低的方案，并算出相对基准的节省额", () => {
  const r = compareScenarios([
    { id: "baseline", label: "不使用优惠", totalCents: 49850 },
    { id: "GMS001", label: "保鲜速达", totalCents: 38145 },
    { id: "GMS003", label: "专人摆台", totalCents: 45308 },
  ]);

  assert.equal(r.best.id, "GMS001");
  assert.equal(r.best.totalCents, 38145);
  assert.equal(r.savingVsBaselineCents, 11705);
  assert.equal(r.savingVsWorstCents, 11705);
  assert.equal(r.baselineSource, "explicit");
  assert.equal(r.isTie, false);
});

test("比价：并列最低时按 id 字典序确定性择一，并列出全部并列者", () => {
  const r = compareScenarios([
    { id: "z", label: "Z", totalCents: 9850 },
    { id: "a", label: "A", totalCents: 9850 },
  ]);

  assert.equal(r.best.id, "a");
  assert.equal(r.isTie, true);
  assert.deepEqual(r.tiedIds, ["a", "z"]);
  assert.equal(r.savingVsBaselineCents, 0);
});

test("比价：缺少 baseline 时退化为「最贵方案」为参照，并标明来源", () => {
  const r = compareScenarios([
    { id: "x", label: "X", totalCents: 1000 },
    { id: "y", label: "Y", totalCents: 800 },
  ]);

  assert.equal(r.best.id, "y");
  assert.equal(r.baseline.id, "x");
  assert.equal(r.baselineSource, "fallback-worst");
  assert.equal(r.savingVsBaselineCents, 200);
});

test("比价：sorted 为确定性升序（价格 -> id）", () => {
  const r = compareScenarios([
    { id: "c", label: "C", totalCents: 300 },
    { id: "a", label: "A", totalCents: 300 },
    { id: "b", label: "B", totalCents: 100 },
  ]);
  assert.deepEqual(
    r.sorted.map((s) => s.id),
    ["b", "a", "c"],
  );
});

test("比价：非法输入必须抛错", () => {
  assert.throws(() => compareScenarios([]), /至少需要一个候选方案/);
  assert.throws(() => compareScenarios([{ label: "无 id", totalCents: 1 }]), /非空字符串 id/);
  assert.throws(() => compareScenarios([{ id: "a", totalCents: 1.5 }]), /整数分/);
  assert.throws(() => compareScenarios([{ id: "a", totalCents: -1 }]), /总价为负/);
});

test("比价：单方案时节省额为 0 且不报错", () => {
  const r = compareScenarios([{ id: "only", label: "唯一", totalCents: 500 }]);
  assert.equal(r.best.id, "only");
  assert.equal(r.savingVsBaselineCents, 0);
  assert.equal(r.isTie, false);
});
