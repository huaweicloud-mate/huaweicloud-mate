// cloud-server/mcp-routes.js — MCP over HTTP 端点
// 将 huaweicloud_invoke 转为 A2A task，参考 Demo 的 mcp-bridge/server.ts
import { createTask, streamTask } from "./task-manager.js";

export function mcpRouter(app) {

  // MCP 请求统一走 /mcp (POST only)
  app.post("/mcp", async (req, res) => {
    const call = req.body;

    if (!call || !call.method) {
      return res.status(400).json({ error: "invalid MCP request" });
    }

    // initialize
    if (call.method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "Huawei Cloud Agent", version: "2.0.0" },
        },
      });
    }

    // tools/list
    if (call.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          tools: [{
            name: "huaweicloud_invoke",
            description:
              "使用自然语言操作华为云资源。支持查询、创建、修改、删除资源。\n" +
              "示例: '查 cn-north-4 的 ECS' / '列出 OBS 桶' / '查看 VPC'",
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

    // notifications/initialized
    if (call.method === "notifications/initialized") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: {} });
    }

    // tools/call — the main handler
    if (call.method === "tools/call") {
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
        // 创建 A2A task (复用 task-manager)
        const task = await createTask(req.userId, intent, {}, req.user);

        // 等待任务完成 (streamTask → SSE)
        const text = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error("任务超时"));
          }, 300000); // 5min

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
          jsonrpc: "2.0",
          id: call.id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (err) {
        return res.json({
          jsonrpc: "2.0",
          id: call.id,
          result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
        });
      }
    }

    return res.json({
      jsonrpc: "2.0", id: call.id,
      error: { code: -32601, message: `Unknown method: ${call.method}` },
    });
  });
}
