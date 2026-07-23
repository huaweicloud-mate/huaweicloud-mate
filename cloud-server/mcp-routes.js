// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import { verifyJwt, userStore, generateLoginCode } from "./auth.js";
import QRCode from "qrcode";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_INDEX = JSON.parse(readFileSync(join(__dirname, "..", "huaweicloud-mate", "data", "capability_index.json"), "utf8"));
const { catalog, search_index } = CAPABILITY_INDEX;

function searchCapabilities(query) {
  const q = query.toLowerCase();
  const ids = [];
  // 按关键词匹配 search_index
  for (const key of Object.keys(search_index)) {
    if (key.toLowerCase().includes(q)) {
      ids.push(...search_index[key]);
    }
  }
  // 也在 catalog 里直接搜
  if (ids.length === 0) {
    for (const [id, entry] of Object.entries(catalog)) {
      if (id.includes(q)) ids.push(id);
    }
  }
  return ids.slice(0, 10).map(id => {
    const e = catalog[id] || {};
    return { id, summary: e.summary || id, operation: e.executors?.koocli?.operation || "", resource: e.resource || "" };
  });
}

export function mcpRouter(app) {

  // MCP initialize / tools/list — 无需认证（能力发现）
  app.post("/mcp", (req, res, next) => {
    const call = req.body;
    if (!call || !call.method) return next();
    if (call.method === "initialize") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "Huawei Cloud Agent", version: "2.0.0" },
        },
      });
    }
    if (call.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          tools: [
            {
              name: "huaweicloud_search",
              description:
                "搜索华为云能力索引，查询产品功能、规格说明、操作步骤。不需要登录。\n" +
                "示例: 'ECS 有哪些规格' / 'OBS 桶怎么创建' / 'VPC 的安全组规则'",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "搜索关键词（产品名、功能名、操作名）" },
                },
                required: ["query"],
              },
            },
            {
              name: "huaweicloud_invoke",
              description:
                "操作华为云实时资源。需要登录认证。支持查询、创建、修改、删除资源。\n" +
                "示例: '查 cn-south-1 的 ECS 实例' / '列出 OBS 桶' / '创建 VPC'",
              inputSchema: {
                type: "object",
                properties: {
                  intent: { type: "string", description: "华为云操作的自然语言描述" },
                },
                required: ["intent"],
              },
            },
          ],
        },
      });
    }
    if (call.method === "notifications/initialized") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: {} });
    }
    next();
  });

  // tools/call — 按工具名路由
  app.post("/mcp", async (req, res) => {
    const call = req.body;

    if (!call || call.method !== "tools/call") {
      return res.status(400).json({ error: "invalid MCP request" });
    }

    const { name, arguments: args } = call.params || {};

    // ====== huaweicloud_search：无鉴权，搜索能力索引 ======
    if (name === "huaweicloud_search") {
      const query = args?.query || "";
      if (!query) {
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text: "请提供搜索关键词 (query)" }], isError: true },
        });
      }
      const results = searchCapabilities(query);
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          content: [{
            type: "text",
            text: results.length > 0
              ? `找到 ${results.length} 条相关能力:\n${results.map((r, i) => `${i + 1}. ${r.summary} (${r.operation || r.resource})`).join("\n")}`
              : `未找到与 "${query}" 相关的华为云能力，请尝试更具体的关键词`,
          }],
        },
      });
    }

    // ====== huaweicloud_invoke：需 JWT 鉴权 ======
    if (name === "huaweicloud_invoke") {
      // JWT 校验
      const authHeader = req.headers.authorization || "";
      let userId = null;
      let user = null;
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const payload = verifyJwt(token);
        if (payload) {
          const u = userStore.get(payload.sub);
          if (u) {
            userId = payload.sub;
            user = u;
          }
        }
      }

      if (!userId) {
        const code = generateLoginCode();
        const qrPath = `${tmpdir()}/qrcode-login-${code}.png`;
        await QRCode.toFile(qrPath, `http://127.0.0.1:3000/auth/confirm/${code}`, { type: "png", width: 400, margin: 2 });
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                type: "AUTH_REQUIRED",
                code,
                qrImage: qrPath,
                message: `扫码或粘贴确认码 ${code} 到聊天框完成登录，有效期 30 秒`
              }),
            }],
          },
        });
      }

      const intent = args?.intent || "";
      if (!intent) {
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text: "Error: 请提供 intent" }], isError: true },
        });
      }

      try {
        const task = await createTask(userId, intent, { source: "mcp" }, user);

        const text = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error("任务超时"));
          }, 300000);

          const unsubscribe = streamTask(task.id, (event) => {
            if (event.status === "completed") {
              clearTimeout(timeout);
              unsubscribe();
              resolve(task.output || event.message || "任务完成");
            } else if (event.status === "failed") {
              clearTimeout(timeout);
              unsubscribe();
              reject(new Error(event.error || "任务失败"));
            }
          });
        });

        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (err) {
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
        });
      }
    }

    // 未知工具
    return res.json({
      jsonrpc: "2.0", id: call.id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
  });
}
