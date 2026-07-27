// cloud-server/redis-store.js — Redis 存储，不可用时自动降级为内存
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";

let redis = null;
try {
  if (REDIS_URL) {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.ping();
    console.log("[redis-store] Redis connected");
  }
} catch { console.log("[redis-store] Redis unavailable, using memory fallback"); }

const memStore = new Map();

async function getUser(userId) {
  if (redis) {
    const data = await redis.hgetall(`user:${userId}`);
    return Object.keys(data).length > 0 ? data : null;
  }
  return memStore.get(userId) || null;
}

async function setUser(userId, data) {
  if (redis) {
    await redis.hset(`user:${userId}`, data);
    await redis.expire(`user:${userId}`, 86400); // 24h TTL
  }
  memStore.set(userId, data);
}

async function getJob(userId) {
  if (redis) {
    const data = await redis.hgetall(`job:${userId}`);
    if (Object.keys(data).length === 0) return null;
    const age = Date.now() - parseInt(data.startTime);
    if (age > 1800000) { await redis.del(`job:${userId}`); return null; }
    return data;
  }
  return null; // memory job cache handled by sandbox.js directly
}

async function setJob(userId, data) {
  if (redis) {
    await redis.hset(`job:${userId}`, { ...data, startTime: String(data.startTime || Date.now()) });
    await redis.expire(`job:${userId}`, 1800); // 30min TTL
  }
}

async function delJob(userId) {
  if (redis) await redis.del(`job:${userId}`);
}

export { getUser, setUser, getJob, setJob, delJob };
