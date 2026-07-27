// cloud-server/redis-store.js — DCS Redis 主存储
// 用户数据 + Job 状态以 Redis 为准，不可用时拒绝请求（不降级为内存）
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";

let redis = null;
(async () => {
  if (REDIS_URL) {
    try {
      redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, retryStrategy: () => null });
      await redis.ping();
      console.log("[redis-store] Redis connected");
    } catch { redis = null; console.log("[redis-store] Redis unavailable"); }
  }
})();

export function isRedisAvailable() { return redis !== null; }

// ── 用户 ──

export async function getUser(userId) {
  if (!redis) throw new Error("Redis unavailable");
  const data = await redis.hgetall(`user:${userId}`);
  if (Object.keys(data).length === 0) return null;
  data.createdAt = parseInt(data.createdAt) || Date.now();
  return data;
}

export async function setUser(userId, data) {
  if (!redis) throw new Error("Redis unavailable");
  const flat = {};
  for (const [k, v] of Object.entries(data)) flat[k] = String(v ?? "");
  await redis.hset(`user:${userId}`, flat);
  await redis.expire(`user:${userId}`, 86400); // 24h TTL
  if (data.ak) await redis.setex(`akidx:${data.ak}`, 86400, userId);
}

export async function delUser(userId) {
  if (!redis) throw new Error("Redis unavailable");
  const data = await redis.hgetall(`user:${userId}`);
  if (data?.ak) await redis.del(`akidx:${data.ak}`);
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

export async function countUsers() {
  if (!redis) return 0;
  const keys = await redis.keys("user:*");
  return keys.length;
}
