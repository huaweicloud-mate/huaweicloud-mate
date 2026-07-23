// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import { verifyJwt, userStore, generateLoginCode, confirmLoginCode, getLoginIntent } from "./auth.js";
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
          tools: [
            {
              name: "huaweicloud_invoke",
              description:
                "使用自然语言操作华为云资源。需要登录认证。\n" +
                "示例: '查 cn-south-1 的 ECS' / '列出 OBS 桶' / '查看 VPC'",
              inputSchema: {
                type: "object",
                properties: {
                  intent: { type: "string", description: "华为云操作的自然语言描述" },
                },
                required: ["intent"],
              },
            },
            {
              name: "huaweicloud_confirm",
              description:
                "用户扫码或输入确认码后，调用此工具完成登录。\n" +
                "当用户发送 4 位大写字母数字组合（如 QYWF）时，提取该码调用此工具。\n" +
                "登录成功后，系统自动签发新 JWT 并写入配置文件。",
              inputSchema: {
                type: "object",
                properties: {
                  code: { type: "string", description: "4 位确认码" },
                },
                required: ["code"],
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

  app.post("/mcp", async (req, res) => {
    const call = req.body;

    if (!call || call.method !== "tools/call") {
      return res.status(400).json({ error: "invalid MCP request" });
    }

    const { name, arguments: args } = call.params || {};

    // ====== huaweicloud_confirm：确认登录 ======
    if (name === "huaweicloud_confirm") {
      const code = (args?.code || "").trim().toUpperCase();
      if (!code || code.length !== 4) {
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text: "无效的确认码，请输入 4 位确认码" }], isError: true },
        });
      }
      const token = confirmLoginCode(code);
      if (!token) {
        return res.json({
          jsonrpc: "2.0", id: call.id,
          result: { content: [{ type: "text", text: "确认码无效或已过期，请重新发起登录" }], isError: true },
        });
      }
      const savedIntent = getLoginIntent(code);
      const resultMsg = JSON.stringify({ success: true, message: "登录成功，JWT 已签发" + (savedIntent ? "，正在执行：" + savedIntent : "") });
      // 如果有缓存的 intent，自动执行
      if (savedIntent) {
        try {
          const task = await createTask(userStore.values().next().value.userId, savedIntent, { source: "mcp" }, userStore.values().next().value);
          const text = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { unsubscribe(); reject(new Error("超时")); }, 300000);
            const unsubscribe = streamTask(task.id, (event) => {
              if (event.status === "completed") { clearTimeout(timeout); unsubscribe(); resolve(task.output || event.message || "完成"); }
              else if (event.status === "failed") { clearTimeout(timeout); unsubscribe(); reject(new Error(event.error || "失败")); }
            });
          });
          return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: resultMsg + "\n\n" + text }] } });
        } catch (e) {
          return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: resultMsg + "\n执行失败: " + e.message }], isError: true } });
        }
      }
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: { content: [{ type: "text", text: resultMsg }] },
      });
    }

    // ====== huaweicloud_invoke ======
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
      const code = generateLoginCode(intent);
      await QRCode.toFile(`/tmp/qrcode-login-${code}.png`, `http://127.0.0.1:3000/auth/confirm/${code}`, { type: "png", width: 400, margin: 2 });
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              type: "AUTH_REQUIRED",
              code,
              qrImage: `http://127.0.0.1:3000/auth/qr/${code}.png`,
              message: `需要登录认证。扫码或在聊天框输入确认码 ${code}，然后调用 huaweicloud_confirm 完成登录。30 秒有效`,
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
