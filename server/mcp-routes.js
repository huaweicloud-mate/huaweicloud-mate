// cloud-server/mcp-routes.js — MCP over HTTP 端点
// 用户数据从 DCS Redis 读写，无内存 Map
import { createTask, streamTask } from "./task-manager.js";
import crypto from "node:crypto";
import { verifyJwt, issueJwt, isRedisAvailable } from "./auth.js";
import { getUser, setUser, findUserIdByAk } from "./redis-store.js";
import { getDomainId, getVoucher, claimVoucher, markVoucherClaimed } from "./db.js";
import { createAnonymousContainer } from "./sandbox.js";
import { createTemporaryCredentials } from "./sts.js";
import { checkCouponIssued, checkLocalQuota, issueCoupon, isBetaAPI } from "./incentive.js";

const VOUCHER_FACE_AMOUNT = process.env.INCENTIVE_FACE_AMOUNT || "100";

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
        { name: "huaweicloud_auth",           description: "认证。测试环境需传domain_id(华为云账号ID)。temp_credential=true时后端用AK/SK换临时凭证，沙箱仅收到临时AK/SK/SecurityToken(6h)。", inputSchema: { type:"object", properties:{ ak:{type:"string"},sk:{type:"string"},region:{type:"string"},domain_id:{type:"string",description:"测试环境必填：华为云账号ID"},temp_credential:{type:"boolean"} } } },
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
      const useTemp = args?.temp_credential === true || args?.temp_credential === "true" || args?.temp_credential === 1;

      const akRegionKey = ak && region ? `${ak}:${region}` : ak;
      let userId = akRegionKey ? (await findUserIdByAk(akRegionKey)) : null;
      if (!userId) {
        userId = crypto.randomUUID().slice(0, 8);
        await setUser(userId, { userId, ak, sk, region, createdAt: Date.now() });
      }

      const user = await getUser(userId);

      // 查券：本地 MySQL + 激励服务 + 上限 三重校验
      let voucherInfo = "", voucherAllowed = false;
      if (ak && sk) {
        let domainId;
        if (isBetaAPI()) {
          // 测试环境：用户必须提供 domain_id
          domainId = args?.domain_id || "";
          if (!domainId) {
            return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"测试环境需提供 domain_id 参数" }], isError:true } });
          }
        } else {
          // 生产环境：hcloud 实时获取
          try {
            domainId = await getDomainId(ak, sk);
          } catch (err) {
            console.error(`[mcp] getDomainId failed: ${err.message}`);
            return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:`获取华为云账号信息失败: ${err.message}` }], isError:true } });
          }
        }
        // 存入 Redis 供后续 voucher_status/claim 使用
        await setUser(userId, { ...user, ak, sk, region, domainId, createdAt: Date.now() });

        try {
          // 第0层: 检查本地是否已达上限
          const quota = await checkLocalQuota();
          if (quota.reached) {
            voucherInfo = "已达领取上限";
            voucherAllowed = false;
          } else {
            // 第1层: 本地 MySQL
            const local = await getVoucher(domainId);
            const localClaimed = local && local.status === 1;
            // 第2层: 激励服务
            const incentive = await checkCouponIssued(domainId);
            const incentiveClaimed = incentive.issued;

            if (localClaimed || incentiveClaimed) {
              voucherInfo = "已领取";
              voucherAllowed = false;
            } else {
              voucherInfo = "未领取";
              voucherAllowed = true;
            }
          }
        } catch (err) { console.error(`[mcp] voucher check failed: ${err.message}`); }
      }

      // 临时凭证模式：后端 STS 换临时 AK/SK/Token
      let tempInfo = {}, tempCreds = null;
      if (useTemp && ak && sk) {
        try {
          tempCreds = await createTemporaryCredentials(ak, sk, region);
          await setUser(userId, {
            ...user, ak, sk,
            temp_ak: tempCreds.ak, temp_sk: tempCreds.sk,
            temp_security_token: tempCreds.securityToken,
            temp_expires_at: tempCreds.expiresAt, temp_credential: "true",
          });
          tempInfo = { temp_credential: true, expires_at: tempCreds.expiresAt };
        } catch (err) {
          tempInfo = { temp_credential: false, sts_error: err.message };
        }
      }

      const token = issueJwt(userId);

      // 预热沙箱（临时凭证模式用临时 AK/SK，长期模式用原始 AK/SK）
      const sandboxAk = tempCreds ? tempCreds.ak : user.ak;
      const sandboxSk = tempCreds ? tempCreds.sk : user.sk;
      const sandboxToken = tempCreds ? tempCreds.securityToken : undefined;
      setImmediate(async () => {
        try {
          const { getOrCreateContainer, destroyContainer } = await import("./sandbox.js");
          if (tempCreds) {
            try { await destroyContainer(userId); } catch (_) {}
          }
          await getOrCreateContainer(userId, { ...user, ak: sandboxAk, sk: sandboxSk, securityToken: sandboxToken });
        } catch (err) { console.error(`[mcp] sandbox preheat failed: ${err.message}`); }
      });

      return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type:"text", text: JSON.stringify({ success: true, token, mode: (ak && sk) ? "real" : "mock", voucher: voucherInfo || undefined, voucherAllowed, ...tempInfo }) }] } });
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
      try { const { destroyContainer } = await import("./sandbox.js"); await destroyContainer(userId); } catch (err) { console.error(`[mcp] destroyContainer on credential update failed: ${err.message}`); }
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, message:"AK/SK 已更新，旧沙箱已销毁" }) }] } });
    }

      // ── huaweicloud_voucher_status ──
    if (name === "huaweicloud_voucher_status") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token无效" }], isError:true } });
      const u = await getUser(payload.sub);
      if (!u?.ak || !u?.sk) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请提供 AK/SK 登录以查询" }], isError:true } });

      const domainId = u.domainId;
      if (!domainId) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先调用 huaweicloud_auth 完成认证" }], isError:true } });
      const local = await getVoucher(domainId);
      const incentive = await checkCouponIssued(domainId);
      const quota = await checkLocalQuota();
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({
        claimed: (local && local.status === 1) || incentive.issued,
        localClaimed: !!(local && local.status === 1),
        incentiveClaimed: incentive.issued,
        quotaReached: quota.reached,
        voucherId: local?.voucher_id || null,
        amount: local?.amount || null,
      }) }] } });
    }

    // ── huaweicloud_voucher_claim ──
    if (name === "huaweicloud_voucher_claim") {
      const payload = verifyJwt(args?.token || "");
      if (!payload) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token无效" }], isError:true } });
      const u = await getUser(payload.sub);
      if (!u?.ak || !u?.sk) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先登录并绑定 AK/SK" }], isError:true } });

      // 从 Redis 读取 auth 时存储的 domainId
      const domainId = u.domainId;
      if (!domainId) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先调用 huaweicloud_auth 完成认证" }], isError:true } });

      // 重新双检：本地 + 激励
      const local = await getVoucher(domainId);
      if (local && local.status === 1) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"已领取过" }) }] } });

      const incentiveCheck = await checkCouponIssued(domainId);
      if (incentiveCheck.issued) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"激励侧已领取过" }) }] } });

      // 上限检查
      const quota = await checkLocalQuota();
      if (quota.reached) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:`已达领取上限(${quota.max})` }) }], isError:true } });

      const akHash = crypto.createHash("sha256").update(u.ak).digest("hex");

      // 调激励服务发券
      const issueResult = await issueCoupon(domainId);
      if (!issueResult.success) {
        await markVoucherClaimed(domainId, akHash);
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:`发券失败: ${issueResult.error}` }) }], isError:true } });
      }

      // 写本地 MySQL
      try {
        await claimVoucher(domainId, akHash, issueResult.couponId, parseInt(VOUCHER_FACE_AMOUNT) || 100);
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, voucherId:issueResult.couponId, amount: parseInt(VOUCHER_FACE_AMOUNT)||100, message:"领取成功" }) }] } });
      } catch (err) {
        console.error(`[mcp] claimVoucher DB write failed: ${err.message}`);
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, voucherId:issueResult.couponId, amount: parseInt(VOUCHER_FACE_AMOUNT)||100, message:"领取成功(DB写入失败，已发券)" }) }] } });
      }
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
      if (!userId) {
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"token无效或已过期，请重新调用 huaweicloud_auth 获取新 token" }], isError:true } });
      }
    }

    if (user && user.temp_credential === "true" && user.temp_expires_at) {
      const expiresAt = new Date(user.temp_expires_at).getTime();
      if (Date.now() > expiresAt) {
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"临时凭证已过期，请重新调用 huaweicloud_auth 获取新的临时凭证" }], isError:true } });
      }
    }

    // 无 token →%→ 匿名沙箱
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
