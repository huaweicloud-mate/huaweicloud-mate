// cloud-server/mcp-routes.js — MCP over HTTP 端点
import { createTask, streamTask } from "./task-manager.js";
import crypto from "node:crypto";
import { verifyJwt, userStore, issueJwt } from "./auth.js";
import { setUser } from "./redis-store.js";
import { getDomainId, getVoucher, claimVoucher, markVoucherClaimed } from "./db.js";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://127.0.0.1:3000";

export function mcpRouter(app) {

  app.post("/mcp", (req, res, next) => {
    const call = req.body;
    if (!call || !call.method) return next();
    if (call.method === "initialize") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hdkitservice", version: "5.0.0" } } });
    }
    if (call.method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: { tools: [
        {
          name: "huaweicloud_auth",
          description: "认证并获取 JWT。返回代金券状态但不会自动领取——需要用户明确确认后才调 huaweicloud_voucher_claim 领取。示例: huaweicloud_auth(ak='...', sk='...', region='cn-south-1')",
          inputSchema: { type: "object", properties: { ak: { type: "string" }, sk: { type: "string" }, region: { type: "string" } } },
        },
        {
          name: "huaweicloud_set_credentials",
          description: "更新 AK/SK，自动销毁旧沙箱。",
          inputSchema: { type: "object", properties: { token: { type: "string" }, ak: { type: "string" }, sk: { type: "string" }, region: { type: "string" } }, required: ["token", "ak", "sk"] },
        },
        {
          name: "huaweicloud_voucher_status",
          description: "查询代金券领取状态。",
          inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
        },
        {
          name: "huaweicloud_voucher_claim",
          description: "领取代金券。仅在用户明确表示同意领取后调用。一人只能领取一次，重复调用返回已领取状态。",
          inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
        },
        {
          name: "huaweicloud_invoke",
          description: "操作华为云资源。示例: huaweicloud_invoke(intent='查 ECS', token='...')",
          inputSchema: { type: "object", properties: { intent: { type: "string" }, token: { type: "string" } }, required: ["intent"] },
        },
      ] } });
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

    // ====== huaweicloud_auth ======
    if (name === "huaweicloud_auth") {
      const userId = crypto.randomUUID().slice(0, 8);
      const ak = args?.ak || "";
      const sk = args?.sk || "";
      const region = args?.region || "cn-south-1";
      userStore.set(userId, { userId, ak, sk, region, createdAt: Date.now() });
      setUser(userId, { userId, ak, sk, region }).catch(() => {});

      // 查券状态（MySQL 查 voucher_records）
      let voucherInfo = "";
      if (ak && sk) {
        try {
          const domainId = await getDomainId(ak, sk) || crypto.createHash("sha256").update(ak).digest("hex").slice(0, 16);
          const existing = await getVoucher(domainId);
          if (existing && existing.status === 1) {
            voucherInfo = "已领取";
          } else {
            voucherInfo = "未领取";
          }
          userStore.get(userId).domainId = domainId;
        } catch {}
      }

      const token = issueJwt(userId);
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, token, mode: (ak && sk) ? "real" : "mock", voucher: voucherInfo || undefined }) }] } });
    }

    // ====== huaweicloud_set_credentials ======
    if (name === "huaweicloud_set_credentials") {
      const jwtToken = args?.token || "";
      const payload = verifyJwt(jwtToken);
      if (!payload) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "token 无效" }], isError: true } });
      const userId = payload.sub;
      const ak = args?.ak || "", sk = args?.sk || "", region = args?.region || "cn-south-1";
      if (!ak || !sk) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "ak 和 sk 不能为空" }], isError: true } });
      userStore.set(userId, { userId, ak, sk, region, createdAt: Date.now() });
      setUser(userId, { userId, ak, sk, region }).catch(() => {});
      try { const { destroyContainer } = await import("./sandbox.js"); await destroyContainer(userId); } catch {}
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, message: "AK/SK 已更新，旧沙箱已销毁" }) }] } });
    }

    // ====== huaweicloud_voucher_status ======
    if (name === "huaweicloud_voucher_status") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "token无效" }], isError: true } });
      const u = userStore.get(payload.sub);
      if (!u?.domainId) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "请提供 AK/SK 登录以查询" }], isError: true } });
      const existing = await getVoucher(u.domainId);
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify(existing && existing.status === 1 ? { claimed: true, voucherId: existing.voucherId, amount: existing.amount } : { claimed: false }) }] } });
    }

    // ====== huaweicloud_voucher_claim ======
    if (name === "huaweicloud_voucher_claim") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "token无效" }], isError: true } });
      const u = userStore.get(payload.sub);
      if (!u?.domainId || !u?.ak || !u?.sk) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "请先登录并绑定 AK/SK" }], isError: true } });

      // 先查 MySQL
      const existing = await getVoucher(u.domainId);
      if (existing && existing.status === 1) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ claimed: true, message: "已领取过" }) }] } });

      // 调激励服务
      const akHash = crypto.createHash("sha256").update(u.ak).digest("hex");
      try {
        const claimResp = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/v1/incentive/voucher/claim`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domainId: u.domainId })
        });
        const claim = await claimResp.json();
        if (claim.success) {
          await claimVoucher(u.domainId, akHash, claim.voucherId, claim.amount || 100);
          return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, voucherId: claim.voucherId, amount: claim.amount, message: "领取成功" }) }] } });
        }
      } catch {}
      // 激励返回已领取
      await markVoucherClaimed(u.domainId, akHash);
      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify({ claimed: true, message: "激励侧已领取过" }) }] } });
    }

    // ====== huaweicloud_invoke ======
    if (name !== "huaweicloud_invoke") {
      return res.json({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }
    const intent = (args?.intent || "").trim();
    if (!intent) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "请提供 intent" }], isError: true } });

    const authHeader = req.headers.authorization || "";
    let jwtToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : (args?.token || "");
    let userId = null, user = null;
    if (jwtToken) {
      const payload = verifyJwt(jwtToken);
      if (payload) { const u = userStore.get(payload.sub); if (u) { userId = payload.sub; user = u; } }
    }
    if (!userId) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: "请先调用 huaweicloud_auth 完成认证" }], isError: true } });

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
