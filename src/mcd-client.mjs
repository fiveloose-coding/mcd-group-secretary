/**
 * 麦当劳中国 MCP 客户端
 * ------------------------------------------------------------------
 * 传输：Streamable HTTP（JSON-RPC 2.0）
 * 端点：https://mcp.mcd.cn
 * 握手：initialize -> notifications/initialized -> tools/list -> tools/call
 * 会话：initialize 响应头返回 Mcp-Session-Id，后续请求必须回带
 *
 * 零第三方依赖（使用 Node.js 18+ 内置 fetch），便于任何人 clone 后直接运行。
 */

export const DEFAULT_ENDPOINT = "https://mcp.mcd.cn";
export const PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "mcd-group-secretary", version: "1.0.0" };

/** MCP 调用异常（带 HTTP 状态码，便于上游区分 401 / 429 / 其他） */
export class McpError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * 解析 MCP 响应体：既可能是纯 JSON，也可能是 SSE（text/event-stream）。
 * 返回最后一个可解析的 JSON-RPC 消息；心跳帧等非 JSON 内容安全忽略。
 */
export function parseRpcBody(text, contentType = "") {
  if (!text || !text.trim()) return null;

  if (contentType.includes("text/event-stream")) {
    const frames = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        frames.push(JSON.parse(data));
      } catch {
        /* 心跳或非 JSON 帧：跳过 */
      }
    }
    return frames.length > 0 ? frames[frames.length - 1] : null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把 `tools/call` 的返回展开成普通 JS 值：
 * 优先使用 structuredContent，其次拼接 content[].text 并尝试 JSON 解析。
 */
export function unwrapToolResult(result) {
  if (result == null) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;

  const texts = Array.isArray(result.content)
    ? result.content.filter((c) => c?.type === "text").map((c) => c.text)
    : [];
  const merged = texts.join("\n");
  if (!merged) return result;

  try {
    return JSON.parse(merged);
  } catch {
    return merged;
  }
}

export class McdMcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.token      麦当劳 MCP Token（必填）
   * @param {string} [opts.endpoint] MCP 端点
   * @param {number} [opts.timeoutMs] 单次请求超时
   */
  constructor({ token, endpoint = DEFAULT_ENDPOINT, timeoutMs = 30000 } = {}) {
    if (!token) {
      throw new McpError(
        "缺少 MCP Token：请先设置环境变量 MCD_MCP_TOKEN（申请方式见 README）",
      );
    }
    this.token = token;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.serverInfo = null;
    this._seq = 0;
  }

  /** 发起一次 JSON-RPC 请求，返回 { text, contentType } */
  async _post(payload) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new McpError(
        `无法连接麦当劳 MCP（${this.endpoint}）：${err?.message ?? err}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";

    if (res.status === 401) {
      throw new McpError(
        "MCP Token 无效或已过期（HTTP 401）——请在麦当劳 MCP 控制台重新获取",
        401,
        text,
      );
    }
    if (res.status === 429) {
      throw new McpError("触发服务端限流（HTTP 429），请稍后重试", 429, text);
    }
    if (!res.ok) {
      throw new McpError(
        `MCP 请求失败 HTTP ${res.status}：${text.slice(0, 300)}`,
        res.status,
        text,
      );
    }
    return { text, contentType };
  }

  async _rpc(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: "2.0", method, params };
    if (!notification) payload.id = ++this._seq;

    const { text, contentType } = await this._post(payload);
    if (notification) return null;

    const message = parseRpcBody(text, contentType);
    if (!message) {
      throw new McpError(`MCP ${method} 返回内容无法解析`, 0, text);
    }
    if (message.error) {
      throw new McpError(
        `MCP ${method} 调用失败：${message.error.message ?? JSON.stringify(message.error)}`,
        0,
        message.error,
      );
    }
    return message.result;
  }

  /** 建立会话：initialize + notifications/initialized */
  async initialize() {
    const result = await this._rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this._rpc("notifications/initialized", {}, { notification: true });
    this.serverInfo = result?.serverInfo ?? null;
    return result;
  }

  /** 列出全部工具 */
  async listTools() {
    const result = await this._rpc("tools/list", {});
    return result?.tools ?? [];
  }

  /** 调用工具，返回原始结果对象 */
  async callTool(name, args = {}) {
    return this._rpc("tools/call", { name, arguments: args });
  }

  /** 调用工具并展开为普通 JS 值 */
  async callToolValue(name, args = {}) {
    return unwrapToolResult(await this.callTool(name, args));
  }
}

/** 从环境变量构造客户端（缺 Token 时给出可操作的报错） */
export function clientFromEnv(env = process.env) {
  return new McdMcpClient({ token: env.MCD_MCP_TOKEN });
}
