// cloud-server/mcp-routes.js — MCP over HTTP 端点
// 用户数据从 DCS Redis 读写，无内存 Map
import { createTask, streamTask } from "./task-manager.js";
import crypto from "node:crypto";
import { verifyJwt, issueJwt, isRedisAvailable } from "./auth.js";
import { getUser, setUser, findUserIdByAk } from "./redis-store.js";
import { getDomainId, claimVoucher } from "./db.js";
import { createAnonymousContainer, getConcurrencyStats, isAtConcurrencyLimit } from "./sandbox.js";
import { createTemporaryCredentials } from "./sts.js";
import { checkCouponIssued, checkLocalQuota, issueCoupon, isBetaAPI } from "./incentive.js";

const rawAmount = parseInt(process.env.INCENTIVE_FACE_AMOUNT);
if (!rawAmount || rawAmount <= 0) {
  console.error("[mcp] INCENTIVE_FACE_AMOUNT 未配置或无效，请设置后重启");
  process.exit(1);
}
const VOUCHER_FACE_AMOUNT = String(Math.min(rawAmount, 500));

const PUBLIC_URL = process.env.PUBLIC_URL;
if (!PUBLIC_URL) console.warn("[mcp] PUBLIC_URL not set — AgentCard may point to localhost. Set PUBLIC_URL to the public-facing URL.");

// ── Session Manager (Streamable HTTP) ──
const SESSION_TTL = 30 * 60 * 1000; // 30 min
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) { existing.createdAt = Date.now(); return existing; }
  }
  const id = `mcp-${crypto.randomUUID()}`;
  const session = { id, createdAt: Date.now(), subscribers: new Set() };
  sessions.set(id, session);
  return session;
}

export function pushNotification(sessionId, notification) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const line = `data: ${JSON.stringify(notification)}\n\n`;
  for (const sseRes of session.subscribers) {
    try { sseRes.write(line); } catch (err) { console.error(`[mcp] SSE write failed: ${err.message}`); }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) {
      for (const sub of s.subscribers) { try { sub.end(); } catch (err) { console.error(`[mcp] SSE end failed for stale session ${id}: ${err.message}`); } }
      sessions.delete(id);
    }
  }
}, 60000);

export function mcpRouter(app) {

  // ── GET /mcp — SSE 通道 (Streamable HTTP) ──
  app.get("/mcp", (req, res) => {
    const sessionId = req.headers["mcp-session-id"] || req.query.sessionId;
    if (!sessionId) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Missing mcp-session-id header or sessionId query param" }, id: null });
    const session = getOrCreateSession(sessionId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Mcp-Session-Id", session.id);

    session.subscribers.add(res);

    const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      session.subscribers.delete(res);
    });

    req.socket.setTimeout(0);

    res.write(`event: endpoint\ndata: /mcp\n\n`);
  });

  // ── POST /mcp — JSON-RPC 通道 (Streamable HTTP) ──
  app.post("/mcp", (req, res, next) => {
    const call = req.body;
    if (!call || !call.method) return next();
    if (call.method === "initialize") {
      const sessionId = req.headers["mcp-session-id"];
      const session = getOrCreateSession(sessionId);
      res.set("Mcp-Session-Id", session.id);
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
        let domainId = user.domainId || "";
        let domainIdMissing = false;

        if (!domainId) {
          if (isBetaAPI()) {
            domainId = args?.domain_id || "";
          } else {
            try {
              domainId = await getDomainId(ak, sk);
            } catch (err) {
              console.error(`[mcp] getDomainId failed: ${err.message}`);
              domainIdMissing = true;
            }
          }
          // 先写入 Redis（无论 domainId 是否获取成功），使后续 status/claim 可读状态
          const akHash = crypto.createHash("sha256").update(ak).digest("hex");
          await setUser(userId, {
            ...user, ak, sk, region,
            domainId: domainId || "",
            domain_id_missing: domainIdMissing || !domainId ? "true" : undefined,
            ak_hash: domainId && !domainIdMissing ? akHash : undefined,
            createdAt: Date.now(),
          });
        }

        if (!domainId) {
          voucherInfo = "华为云账号获取失败，请确认 AK/SK 有效（测试环境需传入 domain_id）";
          voucherAllowed = false;
        } else {
        try {
          // 第0层: 检查本地是否已达上限
          const quota = await checkLocalQuota();
          if (quota.reached) {
            voucherInfo = "已达领取上限";
            voucherAllowed = false;
          } else {
            // 以激励服务接口为准判断是否已领取
            const incentive = await checkCouponIssued(domainId);
            if (incentive.serviceError) {
              voucherInfo = "查询失败";
              voucherAllowed = false;
            } else if (incentive.issued) {
              voucherInfo = "已领取";
              voucherAllowed = false;
            } else {
              voucherInfo = "未领取";
              voucherAllowed = true;
            }
          }
        } catch (err) { console.error(`[mcp] voucher check failed: ${err.message}`); voucherInfo = "查询失败"; }
        }
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

      // 并发检查（仅对新用户或非运行中沙箱的用户）
      if (isAtConcurrencyLimit(userId)) {
        return res.json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type:"text", text: JSON.stringify({ success: false, error: `已达最大并发沙箱数 (${getConcurrencyStats().max})，请稍后重试` }) }] } });
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
      if (u.domain_id_missing === "true") return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed: false, message: "华为云账号获取失败，请重新调用 huaweicloud_auth 并确认 AK/SK 有效" }) }], isError:true } });
      if (!domainId) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先调用 huaweicloud_auth 完成认证" }], isError:true } });
      const incentive = await checkCouponIssued(domainId);
      const quota = await checkLocalQuota();
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({
        claimed: incentive.issued,
        incentiveClaimed: incentive.issued,
        serviceError: incentive.serviceError || false,
        quotaReached: quota.reached,
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
      if (u.domain_id_missing === "true") return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:"华为云账号获取失败，请重新调用 huaweicloud_auth 并确认 AK/SK 有效" }) }], isError:true } });
      if (!domainId) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text:"请先调用 huaweicloud_auth 完成认证" }], isError:true } });

      const akHash = crypto.createHash("sha256").update(u.ak).digest("hex");
      if (u.ak_hash && u.ak_hash !== akHash) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:"AK 已变更，请重新调用 huaweicloud_auth 完成认证" }) }], isError:true } });

      // 以激励服务接口为准确认是否已领取
      const incentiveCheck = await checkCouponIssued(domainId);
      if (incentiveCheck.serviceError) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:"激励服务查询失败，请稍后重试" }) }], isError:true } });
      if (incentiveCheck.issued) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"已领取过" }) }] } });

      // 上限检查
      const quota = await checkLocalQuota();
      if (quota.reached) return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message:`已达领取上限(${quota.max})` }) }], isError:true } });

      // 调激励服务发券
      const issueResult = await issueCoupon(domainId);
      if (!issueResult.success) {
        if (issueResult.errorCode === "HD.60620016") {
          return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:true, message:"已领取过" }) }] } });
        }
        let errMsg = `发券失败: ${issueResult.error}`;
        if (issueResult.errorCode === "HD.60630022") {
          errMsg += ` 请先完成实名认证：https://account.huaweicloud.com/usercenter/?region=cn-north-4&locale=zh-cn#/accountindex/realNameAuthing`;
        }
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ claimed:false, message: errMsg }) }], isError:true } });
      }

      // 写本地 MySQL
      try {
        await claimVoucher(domainId, akHash, issueResult.couponId, parseInt(VOUCHER_FACE_AMOUNT));
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, voucherId:issueResult.couponId, amount: parseInt(VOUCHER_FACE_AMOUNT), message:"领取成功" }) }] } });
      } catch (err) {
        console.error(`[mcp] claimVoucher DB write failed: ${err.message}`);
        return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: JSON.stringify({ success:true, voucherId:issueResult.couponId, amount: parseInt(VOUCHER_FACE_AMOUNT), message:"DB写入失败，已发券" }) }] } });
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
      const mcpSessionId = req.headers["mcp-session-id"];
      const task = await createTask(userId, intent, { source:"mcp" }, user);
      const text = await new Promise((resolve, reject) => {
        const INVOKE_TIMEOUT = parseInt(process.env.INVOKE_TIMEOUT || "300000");
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error("超时")); }, INVOKE_TIMEOUT);
        let settled = false;
        const finish = (err, result) => {
          if (settled) return; settled = true;
          clearTimeout(timeout);
          if (err) reject(err); else resolve(result);
        };
        req.on("close", () => { unsubscribe(); finish(new Error("客户端已断开"), null); });
        const unsubscribe = streamTask(task.id, (event) => {
          // SSE 进度通知
          if (mcpSessionId) {
            pushNotification(mcpSessionId, {
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { taskId: task.id, status: event.status, progress: event.progress, message: event.message, step: event.currentStep, timestamp: event.timestamp },
            });
          }
          if (event.status === "completed") { unsubscribe(); finish(null, task.output || event.message || "完成"); }
          else if (event.status === "failed") { unsubscribe(); finish(new Error(event.error || "失败"), null); }
        });
      });
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text }] } });
    } catch (err) {
      return res.json({ jsonrpc:"2.0", id:call.id, result:{ content:[{ type:"text", text: `Error: ${err.message}` }], isError:true } });
    }
  });
}
