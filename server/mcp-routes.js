// cloud-server/mcp-routes.js — MCP over HTTP 端点
// 用户数据从 DCS Redis 读写，无内存 Map
import { createTask, streamTask } from "./task-manager.js";
import crypto from "node:crypto";
import { verifyJwt, issueJwt, isRedisAvailable } from "./auth.js";
import { getUser, setUser, findUserIdByAk } from "./redis-store.js";
import { getDomainId, getVoucher, claimVoucher, markVoucherClaimed } from "./db.js";
import { createAnonymousContainer } from "./sandbox.js";
import { createTemporaryCredentials } from "./sts.js";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://127.0.0.1:3000";

export function mcpRouter(app) {

  app.post("/mcp", (req, res, next) => {
    const call = req.body;
    if (!call || !call.method) return next();
    if (call.method === "initialize") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hc-devkit", version: "5.0.0" } } });
    }
    if (call.method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id: call.id, result: { tools: [
        { name: "huaweicloud_auth",           description: "认证并获取 JWT。返回代金券状态。示例: huaweicloud_auth(ak='...', sk='...', region='cn-south-1')", inputSchema: { type:"object", properties:{ ak:{type:"string"},sk:{type:"string"},region:{type:"string"} } } },
        { name: "huaweicloud_set_credentials",description: "更新 AK/SK，自动销毁旧沙箱。", inputSchema: { type:"object", properties:{ token:{type:"string"},ak:{type:"string"},sk:{type:"string"},region:{type:"string"}}, required:["token","ak","sk"] } },
        { name: "huaweicloud_voucher_status", description: "查询代金券领取状态。", inputSchema: { type:"object", properties:{ token:{type:"string"}}, required:["token"] } },
        { name: "huaweicloud_voucher_claim",  description: "领取代金券（一人一次）。", inputSchema: { type:"object", properties:{ token:{type:"string"}}, required:["token"] } },
        { name: "huaweicloud_invoke",          description: "操作华为云资源。", inputSchema: { type:"object", properties:{ intent:{type:"string"}, token:{type:"string"}}, required:["intent"] } },
      ] } });
    }
    if (call.method === "notifications/initialized") return res.json({ jsonrpc: "2.0", id: call.id, result: {} });
    next();
  });

  app.post("/mcp", async (req, res) => {
    const call = req.body;
    if (!call || call.method !== "tools/call") return res.status(400).json({ error: "invalid MCP request" });
    const { name, arguments: args } = call.params || {};

    // ── huaweicloud_auth ──
    if (name === "huaweicloud_auth") {
      if (!isRedisAvailable()) return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type:"text", text: "Redis 不可用，请稍后重试" }], isError: true } });

      const ak = args?.ak || "", sk = args?.sk || "", region = args?.region || "cn-south-1";
      const useTemp = args?.temp_credential === true;

      let userId = ak ? (await findUserIdByAk(ak)) : null;
      if (!userId) {
        userId = crypto.randomUUID().slice(0, 8);
        await setUser(userId, { userId, ak, sk, region, createdAt: Date.now() });
      }

      const user = await getUser(userId);
      user.domainId = user.domainId || "";

      // 查券（仅首次）
      let voucherInfo = "";
      if (ak && sk && !user.domainId) {
        try {
          user.domainId = await getDomainId(ak, sk) || crypto.createHash("sha256").update(ak).digest("hex").slice(0, 16);
          await setUser(userId, { ...user, domainId: user.domainId });
        } catch {}
      }
      if (user.domainId) {
        try {
          const existing = await getVoucher(user.domainId);
          voucherInfo = (existing && existing.status === 1) ? "已领取" : "未领取";
        } catch {}
      }

      // 临时凭证模式：后端 STS 换临时 AK/SK/Token
      let tempInfo = {};
      if (useTemp && ak && sk) {
        try {
          const temp = await createTemporaryCredentials(ak, sk, region);
          await setUser(userId, {
            ...user,
            ak, sk, // 长期存 Redis
            temp_ak: temp.ak,
            temp_sk: temp.sk,
            temp_security_token: temp.securityToken,
            temp_expires_at: temp.expiresAt,
            temp_credential: "true",
          });
          tempInfo = { temp_credential: true, expires_at: temp.expiresAt };
        } catch (err) {
          // STS 失败 → 降级为长期凭证
          tempInfo = { temp_credential: false, sts_error: err.message };
        }
      }

      const token = issueJwt(userId);

      // 预热沙箱
      const sandboxUser = { ...user, ...(useTemp && tempInfo.temp_credential ? { ak: user.temp_ak, sk: user.temp_sk, securityToken: user.temp_security_token } : { ak: user.ak, sk: user.sk }) };
      setImmediate(async () => {
        try {
          const { getOrCreateContainer } = await import("./sandbox.js");
          await getOrCreateContainer(userId, sandboxUser);
        } catch {}
      });

      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type:"text", text: JSON.stringify({ success: true, token, mode: (ak && sk) ? "real" : "mock", voucher: voucherInfo || undefined, ...tempInfo }) }] } });
    }

    // ── huaweicloud_set_credentials ──
    if (name === "huaweicloud_set_credentials") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token 无效" }], isError:true } });
      const userId = payload.sub;
      const user = await getUser(userId);
      if (!user) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"用户不存在" }], isError:true } });
      const ak = args?.ak || "", sk = args?.sk || "", region = args?.region || "cn-south-1";
      if (!ak || !sk) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"ak 和 sk 不能为空" }], isError:true } });
      await setUser(userId, { ...user, ak, sk, region, createdAt: Date.now() });
      try { const { destroyContainer } = await import("./sandbox.js"); await destroyContainer(userId); } catch {}
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, message:"AK/SK 已更新，旧沙箱已销毁" }) }] } });
    }

    // ── huaweicloud_voucher_status ──
    if (name === "huaweicloud_voucher_status") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token无效" }], isError:true } });
      const u = await getUser(payload.sub);
      if (!u?.domainId) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请提供 AK/SK 登录以查询" }], isError:true } });
      const existing = await getVoucher(u.domainId);
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify(existing && existing.status === 1 ? { claimed:true, voucherId:existing.voucherId, amount:existing.amount } : { claimed:false }) }] } });
    }

    // ── huaweicloud_voucher_claim ──
    if (name === "huaweicloud_voucher_claim") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token无效" }], isError:true } });
      const u = await getUser(payload.sub);
      if (!u?.domainId || !u?.ak || !u?.sk) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先登录并绑定 AK/SK" }], isError:true } });

      const existing = await getVoucher(u.domainId);
      if (existing && existing.status === 1) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"已领取过" }) }] } });

      const akHash = crypto.createHash("sha256").update(u.ak).digest("hex");
      try {
        const claimResp = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/v1/incentive/voucher/claim`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ domainId: u.domainId }) });
        const claim = await claimResp.json();
        if (claim.success) {
          await claimVoucher(u.domainId, akHash, claim.voucherId, claim.amount || 100);
          return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, voucherId:claim.voucherId, amount:claim.amount, message:"领取成功" }) }] } });
        }
      } catch {}
      await markVoucherClaimed(u.domainId, akHash);
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"激励侧已领取过" }) }] } });
    }

    // ── huaweicloud_invoke ──
    if (name !== "huaweicloud_invoke") {
      return res.json({ jsonrpc:"2.0", id:call.id, error: { code:-32601, message: `Unknown tool: ${name}` } });
    }
    const intent = (args?.intent || "").trim();
    if (!intent) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请提供 intent" }], isError:true } });

    const authHeader = req.headers.authorization || "";
    let jwtToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : (args?.token || "");
    let userId = null, user = null;
    if (jwtToken) {
      const payload = verifyJwt(jwtToken);
      if (payload) { user = await getUser(payload.sub); if (user) userId = payload.sub; }
    }

    // 无 token → 匿名沙箱
    if (!userId) {
      try {
        const container = await createAnonymousContainer();
        const sResp = await fetch(`http://${container.podIp}:3005/session/${container.sessionId}/message`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: intent }] }),
        });
        const data = await sResp.json();
        const texts = (data.parts || []).filter(p => p.type === "text").map(p => p.text);
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: texts.join("\n") || JSON.stringify(data) }] } });
      } catch (err) {
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: `匿名查询失败: ${err.message}` }], isError:true } });
      }
    }

    // 有 token → 用户沙箱
    try {
      const task = await createTask(userId, intent, { source:"mcp" }, user);
      const text = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error("超时")); }, 300000);
        const unsubscribe = streamTask(task.id, (event) => {
          if (event.status === "completed") { clearTimeout(timeout); unsubscribe(); resolve(task.output || event.message || "完成"); }
          else if (event.status === "failed") { clearTimeout(timeout); unsubscribe(); reject(new Error(event.error || "失败")); }
        });
      });
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text }] } });
    } catch (err) {
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: `Error: ${err.message}` }], isError:true } });
    }
  });
}
