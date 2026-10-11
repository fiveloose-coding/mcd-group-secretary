import test from "node:test";
import assert from "node:assert/strict";

import { parseOrderSheet, OrderParseError } from "../src/order-parse.mjs";

test("解析：个人条目与中文冒号", () => {
  const result = parseOrderSheet("张三: 巨无霸\n李四：麦香鱼");
  assert.deepEqual(result.participants, ["张三", "李四"]);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].owners, ["张三"]);
  assert.equal(result.items[1].label, "麦香鱼");
});

test("解析：数量支持 x / × / * 三种写法", () => {
  const result = parseOrderSheet("A: 巨无霸 x2\nB: 麦香鱼 ×3\nC: 薯条 *4");
  assert.deepEqual(
    result.items.map((i) => i.qty),
    [2, 3, 4],
  );
  assert.deepEqual(
    result.items.map((i) => i.label),
    ["巨无霸", "麦香鱼", "薯条"],
  );
});

test("解析：共享条目按 @提及 归属，且菜名里不会残留 @", () => {
  const result = parseOrderSheet("张三: 巨无霸\n李四: 麦香鱼\n共享: 薯条 @张三 @李四");
  const shared = result.items[2];
  assert.equal(shared.shared, true);
  assert.equal(shared.label, "薯条");
  assert.deepEqual(shared.owners, ["张三", "李四"]);
});

test("解析：共享条目保留数量", () => {
  const result = parseOrderSheet("A: 巨无霸\nB: 麦香鱼\n共享: 薯条 x2 @A @B");
  assert.equal(result.items[2].qty, 2);
  assert.equal(result.items[2].label, "薯条");
});

test("解析：注释与空行被跳过，参与人顺序按首次出现", () => {
  const result = parseOrderSheet("# 这是注释\n\n李四: 麦香鱼\n\n张三: 巨无霸\n");
  assert.deepEqual(result.participants, ["李四", "张三"]);
  assert.equal(result.items.length, 2);
});

test("解析：@提及 到未作为前缀出现的人 -> 记 warning 但不失败", () => {
  const result = parseOrderSheet("张三: 巨无霸\n共享: 薯条 @张三 @王五");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /王五/);
});

test("解析：共享条目少于 2 位参与人 -> 抛错", () => {
  assert.throws(() => parseOrderSheet("共享: 薯条 @张三"), OrderParseError);
  assert.throws(() => parseOrderSheet("共享: 薯条 @张三"), /至少需要 2 位参与人/);
});

test("解析：没有冒号的行 -> 抛错并带行号", () => {
  assert.throws(() => parseOrderSheet("张三: 巨无霸\n这一行没有冒号"), (err) => {
    assert.ok(err instanceof OrderParseError);
    assert.equal(err.line, 2);
    assert.match(err.message, /第 2 行/);
    return true;
  });
});

test("解析：条目内容为空 -> 抛错", () => {
  assert.throws(() => parseOrderSheet("张三:"), /条目内容为空/);
});

test("解析：数量非法 -> 抛错", () => {
  assert.throws(() => parseOrderSheet("张三: 巨无霸 x0"), /数量非法/);
});

test("解析：完全空的文本 -> 抛错而不是返回空结果", () => {
  assert.throws(() => parseOrderSheet("\n\n# 只有注释\n"), /未解析到任何条目/);
});

test("解析：非字符串输入 -> 抛错", () => {
  assert.throws(() => parseOrderSheet(null), OrderParseError);
});
