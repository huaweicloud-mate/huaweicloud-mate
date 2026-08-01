// cloud-server/auth.js — AK/SK 认证 + JWT 签发
// DCS Redis 为唯一用户数据源，无内存备份
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getUser, setUser, delUser, findUserIdByAk, isRedisAvailable, setLoginCode, getLoginCode, delLoginCode } from "./redis-store.js";

if (!process.env.JWT_SECRET) { console.error("[auth] JWT_SECRET environment variable is required. Exiting."); process.exit(1); }
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || "12h";
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || "1800000");

const SIGV4_MAX_SKEW_MS = 15 * 60 * 1000;

// ── JWT ──

export function issueJwt(userId) {
  return jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyJwt(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── 用户注册 ──

export async function registerUser({ userId, ak, sk, projectId, openaiKey, region }) {
  if (!isRedisAvailable()) throw new Error("Redis unavailable");
  const existing = await getUser(userId);
  if (existing) return { ok: false, error: "用户已存在" };
  await setUser(userId, { userId, ak, sk, projectId: projectId || "", openaiKey: openaiKey || "", region: region || "cn-south-1", createdAt: Date.now() });
  return { ok: true };
}

// ── SigV4 (SDK-HMAC-SHA256) 签名验证 ──

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function parseAuthHeader(header) {
  if (!header || !header.startsWith("SDK-HMAC-SHA256 ")) return null;
  const parts = {};
  header.slice("SDK-HMAC-SHA256 ".length).split(",").forEach((seg) => {
    const eq = seg.indexOf("=");
    if (eq > -1) parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  });
  return { access: parts.Access || null, signedHeaders: parts.SignedHeaders || null, signature: parts.Signature || null };
}

function buildCanonicalRequest(method, path, query, headers, signedHeaders, body) {
  const sorted = signedHeaders.split(";");
  const headerLines = sorted.filter(Boolean).map((h) => `${h}:${(headers[h] || "").trim()}`);
  return [method, path, query, ...headerLines, "", sha256Hex(body)].join("\n");
}

function buildStringToSign(timestamp, canonicalRequest) {
  return ["SDK-HMAC-SHA256", timestamp, sha256Hex(canonicalRequest)].join("\n");
}

export function verifySignature({ method, path, query, headers, body, ak, sk }) {
  const parsed = parseAuthHeader(headers.authorization || "");
  if (!parsed || !parsed.access || !parsed.signedHeaders || !parsed.signature) return { ok: false, error: "Authorization 头格式无效" };
  if (parsed.access !== ak) return { ok: false, error: "AK 不匹配" };

  const timestamp = headers["x-sdk-date"] || headers["X-Sdk-Date"];
  if (!timestamp) return { ok: false, error: "缺少 X-Sdk-Date 头" };
  const skew = Math.abs(Date.now() - new Date(timestamp).getTime());
  if (skew > SIGV4_MAX_SKEW_MS) return { ok: false, error: "请求时间偏差过大" };

  const canonical = buildCanonicalRequest(method, path, query || "", headers, parsed.signedHeaders, body || "");
  const sts = buildStringToSign(timestamp, canonical);
  const signingKey = hmacSha256(sk, hmacSha256(sk, timestamp));
  const computed = hmacSha256(signingKey, sts).toString("hex");

  if (computed !== parsed.signature) return { ok: false, error: "签名验证失败" };
  return { ok: true };
}

// ── Auth 中间件 ──

// A2A 端点：Bearer JWT 或 AK/SK 签名
export async function authFlexible(req, res, next) {
  if (!isRedisAvailable()) return res.status(503).json({ error: "Redis 不可用" });
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authWithJwt(req, res, next);
  }
  if (authHeader.startsWith("SDK-HMAC-SHA256 ")) {
    return authWithAkSk(req, res, next);
  }
  return res.status(401).json({ error: "需要 Bearer Token 或 SDK-HMAC-SHA256 签名" });
}

async function authWithJwt(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "需要 Bearer Token" });
  }
  const token = authHeader.slice(7);
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: "JWT 无效或已过期" });
  const user = await getUser(payload.sub);
  if (!user) return res.status(401).json({ error: "用户不存在" });
  req.userId = payload.sub;
  req.user = user;
  req.authMethod = "jwt";
  next();
}

async function authWithAkSk(req, res, next) {
  const parsed = parseAuthHeader(req.headers.authorization || "");
  if (!parsed || !parsed.access) return res.status(401).json({ error: "签名头格式无效" });

  const userId = await findUserIdByAk(parsed.access);
  if (!userId) return res.status(401).json({ error: "AK 未注册" });

  const user = await getUser(userId);
  if (!user || !user.sk) return res.status(401).json({ error: "用户凭据不完整" });

  const result = verifySignature({
    method: req.method,
    path: req.path,
    query: req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "",
    headers: req.headers,
    body: JSON.stringify(req.body || ""),
    ak: user.ak,
    sk: user.sk,
  });

  if (!result.ok) return res.status(401).json({ error: result.error });

  req.userId = userId;
  req.user = user;
  req.authMethod = "sigv4";
  next();
}

// ── 登录码（短期内存，30s TTL） ──

const CODE_TTL_MS = 30000;
const CODE_GRACE_MS = 5000;
const loginCodeStore = new Map();
const loginIntentStore = new Map();

export function generateLoginCode(opts) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); } while (loginCodeStore.has(code));
  const userId = crypto.randomUUID().slice(0, 8);
  loginCodeStore.set(code, { createdAt: Date.now(), confirmed: false, userId, ak: opts?.ak || "", sk: opts?.sk || "", region: opts?.region || "" });
  setLoginCode(code, loginCodeStore.get(code), Math.ceil(CODE_TTL_MS / 1000)).catch((err) => { console.error("[auth] Failed to persist login code to Redis:", err.message); });
  return code;
}

export function getLoginIntent(code) {
  const intent = loginIntentStore.get(code);
  loginIntentStore.delete(code);
  return intent;
}

export async function confirmLoginCode(code) {
  if (!isRedisAvailable()) return null;
  const entry = getLoginCode(code) ? await getLoginCode(code) : loginCodeStore.get(code);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CODE_TTL_MS) { loginCodeStore.delete(code); return null; }
  const userId = entry.userId;
  const existing = await getUser(userId);
  if (!existing) {
    await setUser(userId, { userId, ak: entry.ak || "", sk: entry.sk || "", region: entry.region || "cn-south-1", createdAt: Date.now() });
  }
  entry.confirmed = true;
  entry.userId = userId;
  return issueJwt(userId);
}

export function pollLoginCode(code) {
  const entry = loginCodeStore.get(code);
  if (!entry) return { confirmed: false, expired: true };
  if (Date.now() - entry.createdAt > CODE_TTL_MS) { loginCodeStore.delete(code); return { confirmed: false, expired: true }; }
  if (entry.confirmed) {
    const token = issueJwt(entry.userId);
    if (!entry.graceSet) {
      entry.graceSet = true;
      setTimeout(() => { loginCodeStore.delete(code); delLoginCode(code); }, CODE_GRACE_MS);
    }
    return { confirmed: true, token };
  }
  return { confirmed: false };
}

export { JWT_SECRET, SESSION_TIMEOUT_MS, CODE_TTL_MS, isRedisAvailable };
