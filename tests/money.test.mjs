import test from "node:test";
import assert from "node:assert/strict";

import { yuanToCents, centsToYuan, formatCents, assertCents } from "../src/money.mjs";

test("元 -> 分：整数与两位小数", () => {
  assert.equal(yuanToCents(12), 1200);
  assert.equal(yuanToCents(15.5), 1550);
  assert.equal(yuanToCents(0), 0);
});

test("元 -> 分：字符串输入（含货币符号、千分位、空白）", () => {
  assert.equal(yuanToCents("15.50"), 1550);
  assert.equal(yuanToCents("¥15.5"), 1550);
  assert.equal(yuanToCents("¥1,234.56"), 123456);
  assert.equal(yuanToCents(" 29 "), 2900);
});

test("元 -> 分：超过两位小数按分四舍五入", () => {
  assert.equal(yuanToCents("0.994"), 99);
  assert.equal(yuanToCents("0.995"), 100);
  assert.equal(yuanToCents("0.999"), 100);
});

test("元 -> 分：负数与非法输入", () => {
  assert.equal(yuanToCents("-3"), -300);
  assert.throws(() => yuanToCents("abc"), /非法金额/);
  assert.throws(() => yuanToCents("1.2.3"), /非法金额/);
  assert.throws(() => yuanToCents(Number.NaN), /非法金额/);
});

test("浮点陷阱：0.1 + 0.2 在分整数域是精确的", () => {
  assert.equal(yuanToCents("0.1") + yuanToCents("0.2"), yuanToCents("0.3"));
  // 对照：浮点元运算会失准
  assert.notEqual(0.1 + 0.2, 0.3);
});

test("分 -> 展示文本", () => {
  assert.equal(formatCents(0), "¥0.00");
  assert.equal(formatCents(1), "¥0.01");
  assert.equal(formatCents(1550), "¥15.50");
  assert.equal(formatCents(100), "¥1.00");
  assert.equal(formatCents(-300), "-¥3.00");
  assert.equal(formatCents(123456), "¥1234.56");
});

test("assertCents 拒绝非整数分", () => {
  assert.equal(assertCents(100), 100);
  assert.throws(() => assertCents(1.5), /整数分/);
  assert.throws(() => formatCents(1.5), /整数分/);
});

test("分 -> 元 是展示方向的反向换算", () => {
  assert.equal(centsToYuan(1550), 15.5);
});
