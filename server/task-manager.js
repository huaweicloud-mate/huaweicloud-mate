// cloud-server/task-manager.js — A2A 任务生命周期管理
// 任务持久化到 MySQL RDS，SSE 订阅保留内存
import crypto from "node:crypto";
import { getOrCreateContainer, destroyContainer, releaseContainer } from "./sandbox.js";
import { insertTask, updateTaskDb, getTaskDb, listTasksByUser } from "./db.js";

const activeTaskCache = new Map();   // 活跃任务缓存（状态频繁变更，减少 MySQL 压力）
const taskSubscribers = new Map();  // SSE 订阅者（必须是内存）

async function createTask(userId, description, context, user) {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const task = {
    id: taskId, userId, description, context,
    status: "pending", progress: 0, currentStep: "任务已接收",
    artifacts: [], output: "", error: null, events: [],
    createdAt: now, updatedAt: now,
  };

  await insertTask(task);
  activeTaskCache.set(taskId, task);

  executeTask(taskId, user).catch((err) => {
    track(taskId, { status: "failed", progress: 0, currentStep: `任务启动失败: ${err.message}`, error: err.message });
    publish(taskId, { type: "failed", status: "failed", error: err.message });
  });

  return task;
}

async function executeTask(taskId, user) {
  const task = getCached(taskId);
  if (!task) return;

  try {
    track(taskId, { status: "working", progress: 5, currentStep: "正在初始化沙箱..." });
    publish(taskId, { type: "status", status: "working", message: "开始分配沙箱..." });

    const container = await getOrCreateContainer(user.userId, user).catch((err) => {
      if (err.message?.includes("ENOENT") || err.message?.includes("connect") || err.code === "ENOENT") {
        console.log("[task-manager] K8s unavailable");
        return null;
      }
      throw err;
    });

    if (!container) {
      track(taskId, { status: "failed", progress: 0, currentStep: "沙箱创建失败", error: "K8s 不可达，无法创建沙箱" });
      publish(taskId, { type: "failed", status: "failed", error: "K8s 不可达，无法创建沙箱" });
      return;
    }

    track(taskId, { progress: 10, currentStep: "沙箱就绪，执行中..." });
    publish(taskId, { type: "progress", progress: 10, message: "沙箱就绪" });

    const podIp = container.podIp;
    let sessionId = container.sessionId;

    if (!sessionId) {
      const sResp = await fetch(`http://${podIp}:3005/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const session = await sResp.json();
      sessionId = session.id;
    }

    track(taskId, { progress: 20, currentStep: "正在分析意图..." });
    publish(taskId, { type: "progress", progress: 20, message: "LLM 分析中" });

    const mResp = await fetch(`http://${podIp}:3005/session/${sessionId}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: task.description }] }),
    });
    const data = await mResp.json();

    const texts = (data.parts || []).filter(p => p.type === "text").map(p => p.text);
    const output = texts.join("\n") || JSON.stringify(data);

    track(taskId, { status: "completed", progress: 100, currentStep: "任务完成", output });
    publish(taskId, { type: "completed", status: "completed", message: "任务执行完成" });

  } catch (err) {
    track(taskId, { status: "failed", progress: task.progress || 0, currentStep: `执行失败: ${err.message}`, error: err.message });
    publish(taskId, { type: "failed", status: "failed", error: err.message });
  }
}

// ── 事件/订阅 ──

function publish(taskId, event) {
  const task = getCached(taskId);
  if (!task) return;
  task.events.push({ ...event, timestamp: new Date().toISOString() });
  task.updatedAt = new Date().toISOString();
  const subs = taskSubscribers.get(taskId);
  if (subs) for (const cb of subs) { try { cb(event); } catch (_) {} }
}

function track(taskId, updates) {
  const task = getCached(taskId);
  if (!task) return;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  updateTaskDb(taskId, updates).catch((err) => {
    console.error(`[task-manager] DB update failed for task ${taskId}: ${err.message}, retrying...`);
    setTimeout(() => {
      updateTaskDb(taskId, updates).catch((err2) => {
        console.error(`[task-manager] DB update retry failed for task ${taskId}: ${err2.message}`);
      });
    }, 1000);
  });
}

function getCached(taskId) {
  return activeTaskCache.get(taskId);
}

async function getTask(taskId) {
  if (activeTaskCache.has(taskId)) return activeTaskCache.get(taskId);
  return await getTaskDb(taskId);
}

function streamTask(taskId, callback) {
  if (!taskSubscribers.has(taskId)) taskSubscribers.set(taskId, new Set());
  taskSubscribers.get(taskId).add(callback);

  const task = getCached(taskId);
  if (task) for (const event of task.events) { try { callback(event); } catch (_) {} }

  return () => {
    const subs = taskSubscribers.get(taskId);
    if (subs) { subs.delete(callback); if (subs.size === 0) taskSubscribers.delete(taskId); }
  };
}

async function cancelTask(taskId) {
  const task = getCached(taskId) || await getTaskDb(taskId);
  if (!task) return;
  if (["completed", "failed", "cancelled"].includes(task.status)) return;
  track(taskId, { status: "cancelled", currentStep: "任务已取消", progress: task.progress });
  publish(taskId, { type: "cancelled", status: "cancelled", message: "任务已被用户取消" });
  try { await destroyContainer(task.userId || task.user_id); } catch (_) {}
}

async function listUserTasks(userId) {
  return await listTasksByUser(userId);
}

export { createTask, getTask, streamTask, cancelTask, listUserTasks };
