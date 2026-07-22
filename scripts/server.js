// scripts/server.js — MCP Server v3：A2A Client 模式
// 本地插件不再是"工具集合"，而是云端 Agent 的委托代理
// Codex 通过 @huawei-cloud 把任务委托给云端，云端自主决定怎么干

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types";
import { decryptEnv } from "./crypto.js";
import { signRequest } from "./huawei-client.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(pluginDir, ".jwt_token");

// ========== 凭证 & 认证 ==========

const creds = decryptEnv(pluginDir);
if (!creds) {
  console.error("[huawei-cloud] 未配置，请先运行: node scripts/setup.js");
  process.exit(1);
}

const API_BASE = creds.API_BASE || "http://localhost:3000";
let jwtToken = loadToken();

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (cached.expiresAt > Date.now()) return cached.token;
    }
  } catch {}
  return null;
}

function saveToken(token) {
  jwtToken = token;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    token,
    expiresAt: Date.now() + 11 * 3600 * 1000,
  }));
}

// ========== HTTP 客户端（AK/SK 签名 或 JWT） ==========

async function apiCall(method, endpoint, body = null, streamCallback = null) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { "Content-Type": "application/json" };
  const bodyStr = body ? JSON.stringify(body) : "";

  if (jwtToken) {
    headers["Authorization"] = `Bearer ${jwtToken}`;
  } else {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const urlObj = new URL(url);
    headers["X-HW-Timestamp"] = timestamp;
    headers["Host"] = urlObj.host;

    const { authorization } = signRequest(
      creds.HUAWEI_AK, creds.HUAWEI_SK,
      creds.HUAWEI_REGION || "cn-north-4",
      "codex-agent",
      method, urlObj.pathname, urlObj.search || "",
      headers, bodyStr
    );
    headers["Authorization"] = authorization;
  }

  const response = await fetch(url, { method, headers, body: bodyStr || undefined });
  const data = await response.json();

  if (data.token) saveToken(data.token);

  if (!response.ok) {
    if (response.status === 401 && jwtToken) {
      jwtToken = null;
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      return apiCall(method, endpoint, body, streamCallback);
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

// SSE 流式读取
async function streamApiCall(endpoint, onEvent) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { Accept: "text/event-stream" };

  if (jwtToken) {
    headers["Authorization"] = `Bearer ${jwtToken}`;
  } else {
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const urlObj = new URL(url);
    headers["Content-Type"] = "application/json";
    headers["X-HW-Timestamp"] = timestamp;
    headers["Host"] = urlObj.host;

    const { authorization } = signRequest(
      creds.HUAWEI_AK, creds.HUAWEI_SK,
      creds.HUAWEI_REGION || "cn-north-4",
      "codex-agent",
      "GET", urlObj.pathname, "", headers, ""
    );
    headers["Authorization"] = authorization;
  }

  const response = await fetch(url, { headers });

  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            onEvent(event);
          } catch {}
        }
      }
    }
  }
}

// ========== AgentCard 缓存 ==========

let cachedAgentCard = null;

async function getAgentCardRemote() {
  if (cachedAgentCard) return cachedAgentCard;
  try {
    cachedAgentCard = await apiCall("GET", "/.well-known/agent.json");
  } catch {
    cachedAgentCard = { name: "Huawei Cloud Agent", skills: [], toolChain: {} };
  }
  return cachedAgentCard;
}

// ========== MCP Tools（精简为任务委托模型） ==========

async function listTools() {
  const agentCard = await getAgentCardRemote();
  const skillList = (agentCard.skills || [])
    .map((s) => `  - ${s.name}: ${s.description.slice(0, 80)}`)
    .join("\n");

  return {
    tools: [
      {
        name: "delegate_task",
        description:
          "将任务委托给华为云 Agent 执行。云端 Agent 会自主选择 koocli、MCP、Skills 等工具完成任务。\n" +
          `云端已具备能力:\n${skillList}\n\n` +
          "你只需描述目标，云端 Agent 负责决策和执行的每一步。",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "任务描述，越具体越好。例如：「在 cn-north-4 区域创建一台 4C8G 的 ECS，安装 Docker，部署这个 Spring Boot 项目」",
            },
            workdir: {
              type: "string",
              description: "云端工作目录，默认 /workspace",
            },
            wait: {
              type: "boolean",
              description: "是否等待任务完成再返回结果（默认 true）。设为 false 则立即返回 taskId。",
              default: true,
            },
          },
          required: ["task"],
        },
      },
      {
        name: "check_task",
        description: "查询之前委托的任务状态和结果。",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务 ID" },
            stream: {
              type: "boolean",
              description: "是否 SSE 流式获取进度（默认 false）",
            },
          },
          required: ["taskId"],
        },
      },
      {
        name: "cancel_task",
        description: "取消正在执行的任务。",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "要取消的任务 ID" },
          },
          required: ["taskId"],
        },
      },
      {
        name: "list_tasks",
        description: "列出所有已委托的任务及状态。",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "agent_info",
        description: "查看云端 Agent 的能力清单和工具链配置。",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
}

async function callTool(name, args) {
  switch (name) {
    // ========== 核心：委托任务 ==========
    case "delegate_task": {
      const data = await apiCall("POST", "/tasks", {
        description: args.task,
        context: {
          workdir: args.workdir || "/workspace",
          timestamp: new Date().toISOString(),
        },
      });

      const taskId = data.taskId;
      const wait = args.wait !== false;

      // 流式读取进度（等待完成）
      if (wait) {
        let output = `任务已委托给华为云 Agent [${taskId}]\n初始状态: ${data.status}\n\n`;
        const events = [];

        await new Promise((resolve) => {
          streamApiCall(`/tasks/${taskId}/stream`, (event) => {
            events.push(event);

            if (event.type === "progress") {
              output += `[${event.progress}%] ${event.message}\n`;
            } else if (event.type === "completed") {
              output += `\n? 任务完成\n\n${event.output || event.message}`;
              resolve();
            } else if (event.type === "failed") {
              output += `\n? 任务失败: ${event.error || event.message}`;
              resolve();
            } else if (event.type === "status") {
              output += `→ ${event.message}\n`;
            } else if (event.type === "artifact") {
              output += `\n产物: ${event.artifact?.name} — ${event.artifact?.url}\n`;
            } else if (event.type === "cancelled") {
              output += `\n任务已取消`;
              resolve();
            }
          }).catch(() => {
            output += "\n(流式读取异常，请用 check_task 查询)";
            resolve();
          });

          // 超时保护
          setTimeout(() => resolve(), 600000);
        });

        return { content: [{ type: "text", text: output }] };
      }

      // 不等，立即返回
      return {
        content: [{
          type: "text",
          text: [
            `任务已委托 [${taskId}]`,
            `状态: ${data.status}`,
            `查询: @huawei-cloud check_task ${taskId}`,
            `流式: @huawei-cloud check_task ${taskId} stream`,
          ].join("\n"),
        }],
      };
    }

    // ========== 查询任务 ==========
    case "check_task": {
      if (args.stream) {
        let output = `任务 ${args.taskId} 实时进度:\n`;
        await new Promise((resolve) => {
          streamApiCall(`/tasks/${args.taskId}/stream`, (event) => {
            if (event.type === "progress") {
              output += `[${event.progress}%] ${event.message}\n`;
            } else if (event.status === "completed") {
              output += `\n? 完成\n${event.output || ""}`;
              resolve();
            } else if (event.status === "failed") {
              output += `\n? 失败: ${event.error || ""}`;
              resolve();
            } else {
              output += `→ ${event.message || event.status}\n`;
            }
          });
          setTimeout(() => resolve(), 600000);
        });
        return { content: [{ type: "text", text: output }] };
      }

      const data = await apiCall("GET", `/tasks/${args.taskId}`);
      return {
        content: [{
          type: "text",
          text: [
            `任务: ${data.taskId}`,
            `状态: ${data.status}`,
            `进度: ${data.progress}%`,
            `当前: ${data.currentStep}`,
            data.error ? `错误: ${data.error}` : "",
            data.output ? `\n输出:\n${data.output.slice(-2000)}` : "",
            data.artifacts?.length
              ? `\n产物:\n${data.artifacts.map((a) => `  - ${a.name}: ${a.url}`).join("\n")}`
              : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    }

    // ========== 取消任务 ==========
    case "cancel_task": {
      const data = await apiCall("DELETE", `/tasks/${args.taskId}`);
      return {
        content: [{ type: "text", text: `任务 ${data.taskId} 已取消` }],
      };
    }

    // ========== 任务列表 ==========
    case "list_tasks": {
      const data = await apiCall("GET", "/tasks");
      if (!data.tasks?.length) {
        return { content: [{ type: "text", text: "暂无任务" }] };
      }
      return {
        content: [{
          type: "text",
          text: [
            "委托历史:",
            ...data.tasks.map(
              (t) => `  [${t.status}] ${t.taskId.slice(0, 8)}... ${t.description.slice(0, 60)} (${t.progress}%)`
            ),
          ].join("\n"),
        }],
      };
    }

    // ========== Agent 信息 ==========
    case "agent_info": {
      const agentCard = await getAgentCardRemote();
      return {
        content: [{
          type: "text",
          text: [
            `=== ${agentCard.name} v${agentCard.version} ===`,
            agentCard.description,
            "",
            "能力清单:",
            ...agentCard.skills.map((s) => `  ? ${s.name}: ${s.description}`),
            "",
            "工具链:",
            `  主工具: ${agentCard.toolChain?.primary || "koocli"}`,
            `  MCP 服务: ${(agentCard.toolChain?.mcpServices || []).join(", ")}`,
            `  Skills: ${(agentCard.toolChain?.skills || []).join(", ")}`,
          ].join("\n"),
        }],
      };
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ========== 启动 ==========

const server = new Server(
  { name: "huawei-cloud-agent", version: "3.0.0-a2a" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, listTools);
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await callTool(name, args || {});
  } catch (err) {
    return { content: [{ type: "text", text: `错误: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[huawei-cloud] A2A Client v3 就绪 → ${API_BASE}`);
