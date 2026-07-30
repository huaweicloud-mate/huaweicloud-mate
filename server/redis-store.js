// cloud-server/redis-store.js — DCS Redis 主存储
// 用户数据 + Job 状态以 Redis 为准，不可用时拒绝请求（不降级为内存）
import Redis from "ioredis";
import crypto from "node:crypto";

const REDIS_URL = process.env.REDIS_URL || "";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.createHash("sha256").update(REDIS_URL || "hdkitservice-default-key").digest();
const ENCRYPTED_FIELDS = ["ak", "sk", "openaiKey"];

function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex").subarray(0, 32), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(data) {
  if (!data) return "";
  try {
    const buf = Buffer.from(data, "base64");
    const iv = buf.subarray(0, 16);
    const tag = buf.subarray(16, 32);
    const encrypted = buf.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex").subarray(0, 32), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch { return data; }
}

let redis = null;
let redisReady = null;

const redisConnectPromise = (async () => {
  if (REDIS_URL) {
    try {
      redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, retryStrategy: (times) => Math.min(times * 200, 5000) });
      await redis.ping();
      console.log("[redis-store] Redis connected");
      redisReady = true;
    } catch (err) { redis = null; redisReady = false; console.log(`[redis-store] Redis unavailable: ${err.message}`); }
  } else {
    redisReady = true;
  }
})();

export async function ensureRedis() {
  await redisConnectPromise;
  return isRedisAvailable();
}

export function isRedisAvailable() { return redis !== null; }

// ── 用户 ──

export async function getUser(userId) {
  if (!redis) throw new Error("Redis unavailable");
  const data = await redis.hgetall(`user:${userId}`);
  if (Object.keys(data).length === 0) return null;
  for (const k of ENCRYPTED_FIELDS) {
    if (data[k]) data[k] = decrypt(data[k]);
  }
  data.createdAt = parseInt(data.createdAt) || Date.now();
  return data;
}

export async function setUser(userId, data) {
  if (!redis) throw new Error("Redis unavailable");
  const flat = {};
  for (const [k, v] of Object.entries(data)) {
    flat[k] = ENCRYPTED_FIELDS.includes(k) ? encrypt(String(v ?? "")) : String(v ?? "");
  }
  await redis.hset(`user:${userId}`, flat);
  await redis.expire(`user:${userId}`, 86400); // 24h TTL
  if (data.ak) await redis.setex(`akidx:${data.ak}${data.region ? ':' + data.region : ''}`, 86400, userId);
}

export async function delUser(userId) {
  if (!redis) throw new Error("Redis unavailable");
  const data = await redis.hgetall(`user:${userId}`);
  if (data?.ak) await redis.del(`akidx:${data.ak}${data.region ? ':' + data.region : ''}`);
  await redis.del(`user:${userId}`);
}

export async function findUserIdByAk(ak) {
  if (!redis) throw new Error("Redis unavailable");
  return await redis.get(`akidx:${ak}`);
}

// ── Job ──

export async function getJob(userId) {
  if (!redis) throw new Error("Redis unavailable");
  const data = await redis.hgetall(`job:${userId}`);
  if (Object.keys(data).length === 0) return null;
  const age = Date.now() - parseInt(data.startTime);
  if (age > 1800000) { await redis.del(`job:${userId}`); return null; }
  return data;
}

export async function setJob(userId, data) {
  if (!redis) throw new Error("Redis unavailable");
  const flat = {};
  for (const [k, v] of Object.entries(data)) flat[k] = String(v ?? "");
  await redis.hset(`job:${userId}`, flat);
  await redis.expire(`job:${userId}`, 1800); // 30min TTL
}

export async function delJob(userId) {
  if (!redis) throw new Error("Redis unavailable");
  await redis.del(`job:${userId}`);
}

// ── 健康/统计 ──

export async function setLoginCode(code, data, ttlSec = 30) {
  if (!redis) return false;
  try {
    await redis.setex(`logincode:${code}`, ttlSec, JSON.stringify(data));
    return true;
  } catch { return false; }
}

export async function getLoginCode(code) {
  if (!redis) return null;
  try {
    const raw = await redis.get(`logincode:${code}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function delLoginCode(code) {
  if (!redis) return;
  try { await redis.del(`logincode:${code}`); } catch {}
}

// ── 健康/统计 ──

export async function countUsers() {
  if (!redis) return 0;
  const keys = await redis.keys("user:*");
  return keys.length;
}

// ── 分布式锁 ──

export async function acquireLock(key, ttlMs = 30000) {
  if (!redis) return true;
  const result = await redis.set(key, String(Date.now()), "PX", ttlMs, "NX");
  return result === "OK";
}

export async function releaseLock(key) {
  if (!redis) return;
  await redis.del(key);
}
