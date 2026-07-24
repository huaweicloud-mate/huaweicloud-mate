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
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Huawei Cloud Agent", version: "2.0.0" } },
      });
    }
    if (call.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0", id: call.id,
        result: {
          tools: [
            {
              name: "huaweicloud_invoke",
              description: "使用自然语言操作华为云资源。需要先登录。示例: '查 cn-south-1 的 ECS' / '列出 OBS 桶'",
              inputSchema: { type: "object", properties: { intent: { type: "string", description: "华为云操作的自然语言描述" } }, required: ["intent"] },
            },
            {
              name: "huaweicloud_login",
              description: "生成登录二维码。返回确认码和二维码图片URL。扫码后调用 huaweicloud_confirm 完成登录。",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "huaweicloud_confirm",
              description: "用户扫码或输入确认码后，调用此工具完成登录。用户发送 4 位大写字母数字组合（如 QYWF）时，提取该码调用此工具。",
              inputSchema: { type: "object", properties: { code: { type: "string", description: "4 位确认码" } }, required: ["code"] },
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
    if (!call || call.method !== "tools/call") return res.status(400).json({ error: "invalid MCP request" });
    const { name, arguments: args } = call.params || {};

    // ====== huaweicloud_login：生成登录二维码 ======
    if (name === "huaweicloud_login") {
      const code = generateLoginCode();
      await QRCode.toFile(`/tmp/qrcode-login-${code}.png`, `http://127.0.0.1:3000/auth/confirm/${code}`, { type: "png", width: 400, margin: 2 });
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ code, qrImage: `http://127.0.0.1:3000/auth/qr/${code}.png`, message: `扫码或在聊天框输入确认码 ${code}，然后调用 huaweicloud_confirm` }) }] } });
    }

    // ====== huaweicloud_confirm：确认登录 ======
    if (name === "huaweicloud_confirm") {
      const code = (args?.code || "").trim().toUpperCase();
      if (!code || code.length !== 4) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "无效确认码" }], isError: true } });
      const token = confirmLoginCode(code);
      if (!token) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "确认码无效或已过期" }], isError: true } });
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, token, message: "登录成功，请运行 node cloud-server/login-qr.js --token " + token + " 保存凭据" }) }] } });
    }

    // ====== huaweicloud_invoke：执行操作 ======
    if (name !== "huaweicloud_invoke") {
      return res.json({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }
    const intent = (args?.intent || "").trim();
    if (!intent) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "请提供 intent" }], isError: true } });

    const authHeader = req.headers.authorization || "";
    let userId = null, user = null;
    if (authHeader.startsWith("Bearer ")) {
      const payload = verifyJwt(authHeader.slice(7));
      if (payload) { const u = userStore.get(payload.sub); if (u) { userId = payload.sub; user = u; } }
    }
    if (!userId) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "未登录。请先调用 huaweicloud_login 获取验证码，扫码后调用 huaweicloud_confirm 完成登录。" }], isError: true } });

    try {
      const task = await createTask(userId, intent, { source: "mcp" }, user);
      const text = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error("超时")); }, 300000);
        const unsubscribe = streamTask(task.id, (event) => {
          if (event.status === "completed") { clearTimeout(timeout); unsubscribe(); resolve(task.output || event.message || "完成"); }
          else if (event.status === "failed") { clearTimeout(timeout); unsubscribe(); reject(new Error(event.error || "失败")); }
        });
      });
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text }] } });
    } catch (err) {
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
    }
  });
}
