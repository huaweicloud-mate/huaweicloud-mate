// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import { authFlexible } from "./auth.js";

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
          tools: [{
            name: "huaweicloud_invoke",
            description:
              "使用自然语言操作华为云资源。支持查询、创建、修改、删除资源。\n" +
              "示例: '查 cn-south-1 的 ECS' / '列出 OBS 桶' / '查看 VPC'",
            inputSchema: {
              type: "object",
              properties: {
                intent: { type: "string", description: "华为云操作的自然语言描述" },
              },
              required: ["intent"],
            },
          }],
        },
      });
    }
    if (call.method === "notifications/initialized") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: {} });
    }
    next();
  });

  // tools/call — 需要认证
  app.post("/mcp", authFlexible, async (req, res) => {
    const call = req.body;

    if (!call || call.method !== "tools/call") {
      return res.status(400).json({ error: "invalid MCP request" });
    }

    const { name, arguments: args } = call.params || {};
    if (name !== "huaweicloud_invoke") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
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
      const task = await createTask(req.userId, intent, { source: "mcp" }, req.user);

      const text = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("任务超时"));
        }, 300000);

        const unsubscribe = streamTask(task.id, (event) => {
          if (event.status === "completed") {
            clearTimeout(timeout);
            unsubscribe();
            resolve(event.message || task.output || "任务完成");
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
  });
}
