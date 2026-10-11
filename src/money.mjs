/**
 * 金额单位换算与格式化（纯函数）
 * ------------------------------------------------------------------
 * 设计约束：本项目所有金额计算一律使用 **整数「分」**，绝不使用浮点元。
 * 浮点元在分摊、比例计算中会产生「差 1 分」的经典问题；
 * 把单位换算收敛到本文件的两个入口，可以一次性把这类问题消灭。
 *
 * 单位口径：
 *   1 元 = 100 分；本文件中所有名为 *Cents 的量，单位均为「分」。
 */

/** 断言必须是整数分，否则抛错（用于守住内部不变量） */
export function assertCents(value, label = "金额") {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label}必须是整数分，收到：${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 元 -> 分。接受 number 或 string（string 走十进制字符串解析，避免浮点误差）。
 * 支持：`12`、`12.5`、`"12.50"`、`"¥12.50"`、`"1,234.56"`、负数。
 */
export function yuanToCents(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`非法金额：${input}`);
    return Math.round(input * 100);
  }

  const raw = String(input).trim().replace(/[¥￥,，\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new TypeError(`非法金额：${input}`);

  const negative = raw.startsWith("-");
  const [intPart, decimalPart = ""] = raw.replace("-", "").split(".");
  const decimals = `${decimalPart}00`.slice(0, 3); // 取 3 位用于四舍五入

  let cents = Number(intPart) * 100 + Number(decimals.slice(0, 2));
  if (Number(decimals[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

/** 分 -> 元（number，仅用于展示或对外输出，禁止再参与精确计算） */
export function centsToYuan(cents) {
  assertCents(cents);
  return cents / 100;
}

/** 分 -> 展示文本，形如 `¥12.50`（负数形如 `-¥3.00`） */
export function formatCents(cents) {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${negative ? "-" : ""}¥${yuan}.${String(rest).padStart(2, "0")}`;
}
