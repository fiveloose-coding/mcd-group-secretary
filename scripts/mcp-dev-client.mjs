// 麦当劳 MCP 开发客户端（零依赖，Node 22+）
// 用途：在开发与联调阶段直接调用麦当劳 MCP（Streamable HTTP），
//       与 WorkBuddy 连接器相互印证（连接器自检 / 独立体检）。
// 用法：
//   node mcp-dev-client.mjs init
//   node mcp-dev-client.mjs list-tools
//   node mcp-dev-client.mjs call <tool-name> '<json-args>'
// Token 读取顺序：环境变量 MCD_MCP_TOKEN -> ~/.workbuddy/mcp.json 中 mcd-mcp 的 Authorization
// 注意：本文件属于开发工具；真实 Token 永远不会写入本文件或输出。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT = "https://mcp.mcd.cn";
const PROTOCOL_VERSION = "2025-06-18";

function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN.trim();
  const cfgPath = join(homedir(), ".workbuddy", "mcp.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const auth = cfg?.mcpServers?.["mcd-mcp"]?.headers?.Authorization ?? "";
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new Error("未找到 Token：请设置环境变量 MCD_MCP_TOKEN，或先在 WorkBuddy 中配置 mcd-mcp 连接器");
  }
  return token;
}

const TOKEN = loadToken();
const BASE_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let sessionId = null;
let nextId = 1;

function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const payload of dataLines) {
    if (payload && (payload.startsWith("{") || payload.startsWith("["))) {
      return JSON.parse(payload);
    }
  }
  return null;
}

async function rpc(method, params, { notification = false } = {}) {
  const headers = { ...BASE_HEADERS };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (res.status === 401) throw new Error("401：Token 无效或已过期，请重新申请");
  if (res.status === 429) throw new Error("429：触发限流（600 次/分钟），请降低请求频率");
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  if (notification) return null;
  const msg = parseBody(text);
  if (!msg) return null;
  if (msg.error) throw new Error(`RPC 错误 ${msg.error.code}：${msg.error.message}`);
  return msg.result;
}

async function ensureSession() {
  const info = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcd-dev-client", version: "0.1.0" },
  });
  await rpc("notifications/initialized", {}, { notification: true });
  return info;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const info = await ensureSession();

  if (cmd === "init") {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (cmd === "list-tools") {
    const tools = await rpc("tools/list", {});
    const names = (tools?.tools ?? []).map((tool) => tool.name);
    console.log(JSON.stringify({ count: names.length, names, raw: tools }, null, 2));
    return;
  }
  if (cmd === "call") {
    const [name, argsRaw] = rest;
    if (!name) throw new Error("用法：node mcp-dev-client.mjs call <tool-name> '<json-args>'");
    const args = argsRaw ? JSON.parse(argsRaw) : {};
    const result = await rpc("tools/call", { name, arguments: args });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`未知命令：${cmd || "(空)"}（可用：init / list-tools / call）`);
}

main().catch((error) => {
  console.error("FAIL:", error.message);
  process.exit(1);
});
