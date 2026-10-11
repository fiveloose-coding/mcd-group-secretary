import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName, diceCoefficient, matchItem, matchAll } from "../src/menu-match.mjs";

const MENU = [
  { code: "901100", name: "巨无霸" },
  { code: "901440", name: "麦辣鸡腿汉堡" },
  { code: "903050", name: "可口可乐" },
  { code: "501205", name: "薯条" },
  { code: "901406", name: "板烧鸡腿堡" },
];

test("归一化：去空白、去标点、全角转半角、转小写", () => {
  assert.equal(normalizeName("  巨无霸！ "), "巨无霸");
  assert.equal(normalizeName("可口 可乐"), "可口可乐");
  assert.equal(normalizeName("ＡＢＣ"), "abc");
  assert.equal(normalizeName("巨无霸（汉堡）"), "巨无霸汉堡");
  assert.equal(normalizeName(null), "");
});

test("Dice 系数：完全相同为 1，无交集为 0", () => {
  assert.equal(diceCoefficient("巨无霸", "巨无霸"), 1);
  assert.equal(diceCoefficient("巨无霸", "薯条"), 0);
  assert.ok(diceCoefficient("麦辣鸡腿汉堡", "板烧鸡腿堡") > 0);
  assert.ok(diceCoefficient("麦辣鸡腿汉堡", "板烧鸡腿堡") < 0.45);
});

test("匹配 R1：完全相等 -> 1.00 exact", () => {
  const r = matchItem("巨无霸", MENU);
  assert.equal(r.matched, true);
  assert.equal(r.best.code, "901100");
  assert.equal(r.score, 1);
  assert.equal(r.source, "exact");
});

test("匹配 R2：别名表命中 -> 1.00 alias", () => {
  const r = matchItem("麦辣鸡腿堡", MENU, { aliases: { 麦辣鸡腿堡: "麦辣鸡腿汉堡" } });
  assert.equal(r.best.code, "901440");
  assert.equal(r.source, "alias");
  assert.equal(r.score, 1);
});

test("匹配 R3：包含关系 -> 0.75 + 0.25 * 短/长", () => {
  const r = matchItem("巨无霸", [{ code: "x", name: "巨无霸汉堡" }]);
  assert.equal(r.matched, true);
  assert.equal(r.source, "contains");
  assert.equal(r.score, 0.9);
});

test("匹配优先级：精确命中优先于包含命中", () => {
  const r = matchItem("巨无霸", [
    { code: "2", name: "巨无霸汉堡" },
    { code: "1", name: "巨无霸" },
  ]);
  assert.equal(r.best.code, "1");
  assert.equal(r.source, "exact");
});

test("匹配 R4：低于阈值不猜，返回未命中 + 候选列表", () => {
  const r = matchItem("麦辣鸡腿汉堡", [{ code: "y", name: "板烧鸡腿堡" }]);
  assert.equal(r.matched, false);
  assert.equal(r.best, null);
  assert.equal(r.source, "below-threshold");
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.alternatives[0].code, "y");
});

test("匹配：并列分数按「名称长度升序 -> 字典序升序」确定性择一", () => {
  const r = matchItem("汉堡", [
    { code: "2", name: "汉堡王" },
    { code: "1", name: "汉堡包" },
  ]);
  assert.equal(r.best.name, "汉堡包");
});

test("匹配：空查询返回空结果而不抛错", () => {
  const r = matchItem("", MENU);
  assert.equal(r.matched, false);
  assert.equal(r.best, null);
  assert.equal(r.source, "empty");
});

test("匹配：候选为空时返回未命中", () => {
  const r = matchItem("巨无霸", []);
  assert.equal(r.matched, false);
  assert.equal(r.best, null);
});

test("matchAll：给出命中数与未命中数", () => {
  const r = matchAll(["巨无霸", "麦辣鸡腿堡", "不存在的菜"], MENU, {
    aliases: { 麦辣鸡腿堡: "麦辣鸡腿汉堡" },
  });
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.matched, 2);
  assert.equal(r.summary.unmatched, 1);
  assert.equal(r.results[2].matched, false);
});

test("匹配结果可复现：同一输入连续调用结果完全一致", () => {
  const a = matchItem("可乐", MENU, { aliases: { 可乐: "可口可乐" } });
  const b = matchItem("可乐", MENU, { aliases: { 可乐: "可口可乐" } });
  assert.deepEqual(a, b);
});
