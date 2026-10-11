/**
 * 拼单文本解析（纯函数）
 * ------------------------------------------------------------------
 * 输入是「群里拼单」这种自然形成的文本，格式刻意做得极简、容错、可肉眼校对：
 *
 *   # 井号开头为注释
 *   张三: 麦辣鸡腿堡
 *   李四: 巨无霸 x2
 *   共享: 大薯条 @张三 @李四
 *
 * 规则（显式，不做猜测）：
 *   R1 空行与 `#` 注释行跳过；
 *   R2 每行形如 `<前缀>: <条目>`，中英文冒号均可；
 *   R3 前缀为 `共享` / `share`（不区分大小写）时，视为多人共享，
 *      参与人从条目中的 `@名字` 提取，少于 2 人则报错；
 *   R4 其余情况前缀即为参与人姓名，该条目由他独占；
 *   R5 条目结尾可写数量 `x2` / `×2` / `*2`（不区分大小写），默认 1；
 *   R6 出现 `@名字` 但该名字未在文件中作为前缀出现过时，记一条 warning（不失败）。
 *
 * 解析失败一律抛 OrderParseError 并带行号——本层不猜、不静默丢弃。
 */

export class OrderParseError extends Error {
  constructor(message, line = 0) {
    super(line ? `第 ${line} 行：${message}` : message);
    this.name = "OrderParseError";
    this.line = line;
  }
}

const SHARED_PREFIXES = new Set(["共享", "share", "分摊", "公共"]);
const LINE_RE = /^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/;
const QTY_RE = /\s*(?:[x×*]\s*(\d+))\s*$/i;

/**
 * @提及 的读写一律新建正则对象：
 * 带 g 标志的正则会保留 lastIndex，模块级复用会造成跨次调用的状态污染。
 */
function extractMentions(text) {
  return [...text.matchAll(/@([^\s@,，、+]+)/g)].map((m) => m[1].trim());
}
function stripMentions(text) {
  return text.replace(/@[^\s@,，、+]+/g, " ");
}
function hasMention(text) {
  return /@[^\s@,，、+]+/.test(text);
}

/**
 * @param {string} text 拼单文本
 * @returns {{participants: string[], items: Array, warnings: string[]}}
 */
export function parseOrderSheet(text) {
  if (typeof text !== "string") {
    throw new OrderParseError("拼单文本必须是字符串");
  }

  const participants = [];
  const items = [];
  const warnings = [];

  const addParticipant = (name) => {
    if (!participants.includes(name)) participants.push(name);
    return name;
  };

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const m = LINE_RE.exec(line);
    if (!m) {
      throw new OrderParseError(
        `无法识别的行格式：${JSON.stringify(line)}（应为「姓名: 条目」或「共享: 条目 @甲 @乙」）`,
        lineNo,
      );
    }

    const prefix = m[1].trim();
    let rest = m[2].trim();
    if (!rest) throw new OrderParseError("条目内容为空", lineNo);

    const isShared = SHARED_PREFIXES.has(prefix.toLowerCase()) || SHARED_PREFIXES.has(prefix);

    let owners;
    let label;

    if (isShared) {
      // R3 共享条目：先剥离 @提及，剩下的才是菜名与数量
      const mentioned = extractMentions(rest);
      label = stripMentions(rest).trim();
      if (!label) throw new OrderParseError("共享条目缺少菜名", lineNo);
      if (mentioned.length < 2) {
        throw new OrderParseError(
          `共享条目至少需要 2 位参与人（用 @姓名 标注），当前 ${mentioned.length} 位`,
          lineNo,
        );
      }
      owners = mentioned.map(addParticipant);
    } else {
      // R4 个人条目：不接受 @提及，避免与共享写法混淆
      if (hasMention(rest)) {
        throw new OrderParseError(
          `个人条目里出现了 @提及（${rest}）——多人共享请改用「共享: 菜名 @甲 @乙」`,
          lineNo,
        );
      }
      label = rest;
      owners = [addParticipant(prefix)];
    }

    // R5 提取数量：写在菜名之后，形如 `菜名 x2`，支持 x / × / *（不区分大小写）
    let qty = 1;
    const qtyMatch = QTY_RE.exec(label);
    if (qtyMatch) {
      qty = Number(qtyMatch[1]);
      if (!Number.isInteger(qty) || qty < 1) {
        throw new OrderParseError(`数量非法：${qtyMatch[0].trim()}`, lineNo);
      }
      label = label.slice(0, qtyMatch.index).trim();
    }
    if (!label) throw new OrderParseError("条目缺少菜名（只写了数量）", lineNo);

    for (const owner of owners) {
      if (!participants.includes(owner)) addParticipant(owner);
    }

    items.push({
      label,
      qty,
      owners,
      shared: isShared,
      line: lineNo,
      raw: rawLine,
    });
  });

  if (items.length === 0) {
    throw new OrderParseError("未解析到任何条目，请检查拼单文本是否为空");
  }

  // R6 交叉核对：@提及 的人若从未作为前缀出现，提示可能是拼写错误
  for (const item of items) {
    if (!item.shared) continue;
    for (const owner of item.owners) {
      const appearedAsPrefix = lines.some((l) => {
        const mm = LINE_RE.exec(l.trim());
        return mm && mm[1].trim() === owner;
      });
      if (!appearedAsPrefix) {
        warnings.push(
          `第 ${item.line} 行：参与人「${owner}」只出现在 @提及 中，文件中没有他的个人条目——请确认姓名拼写。`,
        );
      }
    }
  }

  return { participants, items, warnings };
}
