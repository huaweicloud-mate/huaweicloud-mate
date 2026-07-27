// cloud-server/auth.js — AK/SK 认证 + JWT 签发
// DCS Redis 为唯一用户数据源，无内存备份
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getUser, setUser, delUser, findUserIdByAk, isRedisAvailable } from "./redis-store.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const JWT_EXPIRES = process.env.JWT_EXPIRES || "12h";
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || "1800000");

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

// ── Auth 中间件 ──

// A2A 端点：Bearer JWT 或 AK/SK 签名
export async function authFlexible(req, res, next) {
  if (!isRedisAvailable()) return res.status(503).json({ error: "Redis 不可用" });
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authWithJwt(req, res, next);
  }
  // AK/SK 签名由服务端自行验证（hbcloud SDK 调用）
  return authWithJwt(req, res, next); // 降级为 JWT
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

// ── 登录码（短期内存，30s TTL） ──

const CODE_TTL_MS = 30000;
const loginCodeStore = new Map();
const loginIntentStore = new Map();

export function generateLoginCode(opts) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); } while (loginCodeStore.has(code));
  const userId = crypto.randomUUID().slice(0, 8);
  loginCodeStore.set(code, { createdAt: Date.now(), confirmed: false, userId, ak: opts?.ak || "", sk: opts?.sk || "", region: opts?.region || "" });
  return code;
}

export function getLoginIntent(code) {
  const intent = loginIntentStore.get(code);
  loginIntentStore.delete(code);
  return intent;
}

export async function confirmLoginCode(code) {
  if (!isRedisAvailable()) return null;
  const entry = loginCodeStore.get(code);
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
    loginCodeStore.delete(code);
    return { confirmed: true, token };
  }
  return { confirmed: false };
}

export { JWT_SECRET, SESSION_TIMEOUT_MS, isRedisAvailable };
