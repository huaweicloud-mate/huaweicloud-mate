// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import { verifyJwt, userStore, generateLoginCode } from "./auth.js";
import QRCode from "qrcode";

export function mcpRouter(app) {

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
              "使用自然语言操作华为云资源。支持查询、创建、修改、删除资源。需要登录认证。\n" +
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

  app.post("/mcp", async (req, res) => {
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

    const intent = (args?.intent || "").trim();
    if (!intent) {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: { content: [{ type: "text", text: "请提供 intent" }], isError: true },
      });
    }

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
      const qrPath = `/tmp/qrcode-login-${code}.png`;
      await QRCode.toFile(qrPath, `http://127.0.0.1:3000/auth/confirm/${code}`, { type: "png", width: 400, margin: 2 });
      const qrUrl = `http://127.0.0.1:3000/auth/qr/${code}.png`;
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              type: "AUTH_REQUIRED",
              code,
              qrImage: qrUrl,
              message: `扫码或粘贴确认码 ${code} 到聊天框完成登录，有效期 30 秒`
            }),
          }],
        },
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
  });
}
