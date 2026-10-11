import test from "node:test";
import assert from "node:assert/strict";

import { allocateByWeights, splitBill } from "../src/bill-split.mjs";

/* ------------------------------ 权重分配基础 ------------------------------ */

test("allocateByWeights：整除时精确分配", () => {
  assert.deepEqual(allocateByWeights(900, [1, 1, 1]), [300, 300, 300]);
  assert.deepEqual(allocateByWeights(100, [1, 0, 1]), [50, 0, 50]);
});

test("allocateByWeights：有余数时和仍然严格相等", () => {
  const result = allocateByWeights(100, [1, 1, 1]);
  assert.deepEqual(result, [34, 33, 33]);
  assert.equal(
    result.reduce((a, b) => a + b, 0),
    100,
  );
});

test("allocateByWeights：1 分也要分出去", () => {
  assert.deepEqual(allocateByWeights(1, [1, 1, 1]), [1, 0, 0]);
});

test("allocateByWeights：非等权（按比例）", () => {
  assert.deepEqual(allocateByWeights(100, [1, 10]), [9, 91]);
  const uneven = allocateByWeights(100, [1000, 3000]);
  assert.deepEqual(uneven, [25, 75]);
});

test("allocateByWeights：非法输入必须抛错而不是静默兜底", () => {
  assert.throws(() => allocateByWeights(100, []), /不能为空/);
  assert.throws(() => allocateByWeights(100, [0, 0]), /权重之和不能为 0/);
  assert.throws(() => allocateByWeights(100, [1, -1]), /非负有限数/);
  assert.throws(() => allocateByWeights(1.5, [1]), /整数分/);
});

/* --------------------------------- 三 人 共享 --------------------------------- */

test("splitBill：三人共享一份菜品，余数按给定顺序分配且总额不变", () => {
  const bill = splitBill({
    participants: ["A", "B", "C"],
    items: [{ label: "薯条", unitPriceCents: 1000, owners: ["A", "B", "C"] }],
  });

  assert.equal(bill.subtotalCents, 1000);
  assert.equal(bill.totalCents, 1000);
  assert.deepEqual(
    bill.perPerson.map((p) => p.totalCents),
    [334, 333, 333],
  );
  assert.equal(bill.invariants.sumOfTotalsEqualsGrandTotal, true);
});

test("splitBill：独占与共享混合", () => {
  const bill = splitBill({
    participants: ["张三", "李四"],
    items: [
      { label: "巨无霸", unitPriceCents: 2900, owners: ["张三"] },
      { label: "麦香鱼", unitPriceCents: 2400, owners: ["李四"] },
      { label: "薯条", unitPriceCents: 1550, owners: ["张三", "李四"] },
    ],
  });

  // 薯条 1550 分给两人 -> 775 / 775
  assert.equal(bill.perPerson[0].totalCents, 2900 + 775);
  assert.equal(bill.perPerson[1].totalCents, 2400 + 775);
  assert.equal(bill.totalCents, 2900 + 2400 + 1550);
});

/* --------------------------------- 折 扣 分 摊 -------------------------------- */

test("splitBill：折扣按各人小计比例分摊，且个人之和等于实付", () => {
  const bill = splitBill({
    participants: ["A", "B", "C"],
    items: [
      { label: "甲", unitPriceCents: 1000, owners: ["A"] },
      { label: "乙", unitPriceCents: 1000, owners: ["B"] },
      { label: "丙", unitPriceCents: 1000, owners: ["C"] },
    ],
    discountCents: 100,
  });

  assert.equal(bill.subtotalCents, 3000);
  assert.equal(bill.discountCents, 100);
  assert.equal(bill.totalCents, 2900);
  assert.deepEqual(
    bill.perPerson.map((p) => p.discountCents),
    [34, 33, 33],
  );
  assert.equal(bill.invariants.sumOfTotals, 2900);
});

test("splitBill：折扣按比例而非等分（小计悬殊时）", () => {
  const bill = splitBill({
    participants: ["小单", "大单"],
    items: [
      { label: "小", unitPriceCents: 1000, owners: ["小单"] },
      { label: "大", unitPriceCents: 3000, owners: ["大单"] },
    ],
    discountCents: 400,
  });

  assert.equal(bill.perPerson[0].discountCents, 100); // 1000/4000 * 400
  assert.equal(bill.perPerson[1].discountCents, 300); // 3000/4000 * 400
  assert.equal(bill.totalCents, 3600);
});

test("splitBill：折扣超过小计时按小计截断并给出提示，不产生负数账单", () => {
  const bill = splitBill({
    participants: ["A"],
    items: [{ label: "甲", unitPriceCents: 1000, owners: ["A"] }],
    discountCents: 5000,
  });

  assert.equal(bill.discountCents, 1000);
  assert.equal(bill.totalCents, 0);
  assert.equal(bill.warnings.length, 1);
  assert.match(bill.warnings[0], /已按小计截断/);
});

test("splitBill：负数折扣属于非法输入，必须抛错", () => {
  assert.throws(
    () =>
      splitBill({
        participants: ["A"],
        items: [{ label: "甲", unitPriceCents: 100, owners: ["A"] }],
        discountCents: -1,
      }),
    /不能为负数/,
  );
});

/* --------------------------------- 附 加 费 用 -------------------------------- */

test("splitBill：附加费 equal 按人头均分", () => {
  const bill = splitBill({
    participants: ["A", "B"],
    items: [
      { label: "甲", unitPriceCents: 1000, owners: ["A"] },
      { label: "乙", unitPriceCents: 3000, owners: ["B"] },
    ],
    surchargeCents: 100,
    surchargeAllocation: "equal",
  });

  assert.deepEqual(
    bill.perPerson.map((p) => p.surchargeCents),
    [50, 50],
  );
  assert.equal(bill.totalCents, 4100);
});

test("splitBill：附加费 proportional 按小计比例", () => {
  const bill = splitBill({
    participants: ["A", "B"],
    items: [
      { label: "甲", unitPriceCents: 1000, owners: ["A"] },
      { label: "乙", unitPriceCents: 3000, owners: ["B"] },
    ],
    surchargeCents: 100,
    surchargeAllocation: "proportional",
  });

  assert.deepEqual(
    bill.perPerson.map((p) => p.surchargeCents),
    [25, 75],
  );
  assert.equal(bill.totalCents, 4100);
});

test("splitBill：非法的附加费分摊方式必须抛错", () => {
  assert.throws(
    () =>
      splitBill({
        participants: ["A"],
        items: [{ label: "甲", unitPriceCents: 100, owners: ["A"] }],
        surchargeAllocation: "whatever",
      }),
    /只能是 proportional 或 equal/,
  );
});

/* ---------------------------------- 校 验 层 ---------------------------------- */

test("splitBill：归属人不在参与人列表中必须抛错（防拼写错误静默变成幽灵人）", () => {
  assert.throws(
    () =>
      splitBill({
        participants: ["张三"],
        items: [{ label: "薯条", unitPriceCents: 100, owners: ["张叁"] }],
      }),
    /不在参与人列表中/,
  );
});

test("splitBill：数量与单价非法必须抛错", () => {
  assert.throws(
    () =>
      splitBill({
        participants: ["A"],
        items: [{ label: "甲", unitPriceCents: 100, qty: 0, owners: ["A"] }],
      }),
    /数量非法/,
  );
  assert.throws(
    () =>
      splitBill({
        participants: ["A"],
        items: [{ label: "甲", unitPriceCents: 1.5, owners: ["A"] }],
      }),
    /整数分/,
  );
});

test("splitBill：随机组合下不变量恒成立（1000 次确定性遍历）", () => {
  let seed = 20261011;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  for (let i = 0; i < 1000; i += 1) {
    const peopleCount = 2 + rand(4);
    const participants = Array.from({ length: peopleCount }, (_, k) => `P${k}`);
    const items = Array.from({ length: 1 + rand(4) }, (_, k) => {
      const owners = participants.filter(() => rand(2) === 0);
      return {
        label: `I${k}`,
        unitPriceCents: 1 + rand(5000),
        qty: 1 + rand(3),
        owners: owners.length > 0 ? owners : [participants[rand(peopleCount)]],
      };
    });
    const subtotal = items.reduce((sum, it) => sum + it.unitPriceCents * it.qty, 0);
    const discountCents = rand(subtotal + 1);

    const bill = splitBill({ participants, items, discountCents, surchargeCents: rand(500), surchargeAllocation: rand(2) ? "equal" : "proportional" });
    assert.equal(
      bill.invariants.sumOfTotals,
      bill.totalCents,
      `第 ${i} 次组合不变量失败`,
    );
  }
});
