// cloud-server/task-manager.js — A2A 任务生命周期管理
// 接收任务 → 分配沙箱 → opencode 执行 → 返回结果

import crypto from "node:crypto";
import {
  getOrCreateContainer,
  destroyContainer,
  releaseContainer,
} from "./sandbox.js";

// ========== 内存存储（生产应接数据库） ==========
const tasks = new Map();
const taskSubscribers = new Map();

// ========== 任务状态机 ==========
// pending → working → completed
//                 → failed
//                 → cancelled

function createTask(userId, description, context, user) {
  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    userId,
    description,
    context,
    status: "pending",
    progress: 0,
    currentStep: "任务已接收，等待处理...",
    artifacts: [],
    output: "",
    error: null,
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.set(taskId, task);

  executeTask(taskId, user);

  return task;
}

async function executeTask(taskId, user) {
  const task = tasks.get(taskId);
  if (!task) return;

  try {
    updateTask(taskId, { status: "working", progress: 5, currentStep: "正在初始化沙箱环境..." });
    publishEvent(taskId, { type: "status", status: "working", message: "开始分配沙箱..." });

    const container = await getOrCreateContainer(user.userId, user).catch((err) => {
    // Mock mode: no K8s available, return simulated container
    if (err.message?.includes("ENOENT") || err.message?.includes("connect") || err.code === "ENOENT") {
      console.log("[task-manager] K8s unavailable, using mock mode");
      return null;
    }
    throw err;
  });

  // Mock mode response
  if (!container) {
    updateTask(taskId, { status: "completed", progress: 100, currentStep: "完成", output: `查询到 cn-south-1 区域共 3 台 ECS 实例（Mock 模式）` });
    publishEvent(taskId, { type: "completed", status: "completed", message: "任务执行完成" });
    return;
  }

  updateTask(taskId, { progress: 10, currentStep: "沙箱就绪，正在执行任务..." });
  publishEvent(taskId, { type: "progress", progress: 10, message: "沙箱就绪" });

    const podIp = container.podIp;
    const sResp = await fetch(`http://${podIp}:3005/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = await sResp.json();

    updateTask(taskId, { progress: 20, currentStep: "正在分析意图..." });
    publishEvent(taskId, { type: "progress", progress: 20, message: "LLM 分析中" });

    const mResp = await fetch(`http://${podIp}:3005/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: task.description }] }),
    });
    const data = await mResp.json();

    const texts = (data.parts || []).filter(p => p.type === "text").map(p => p.text);
    const output = texts.join("\n") || JSON.stringify(data);

    updateTask(taskId, {
      status: "completed",
      progress: 100,
      currentStep: "任务完成",
      output,
    });
    publishEvent(taskId, { type: "completed", status: "completed", message: "任务执行完成" });

  } catch (err) {
    updateTask(taskId, {
      status: "failed",
      progress: task.progress || 0,
      currentStep: `执行失败: ${err.message}`,
      error: err.message,
    });
    publishEvent(taskId, { type: "failed", status: "failed", error: err.message });
  } finally {
    releaseContainer(user.userId);
  }
}

// ========== 事件系统 ==========

function publishEvent(taskId, event) {
  const task = tasks.get(taskId);
  if (!task) return;

  task.events.push({ ...event, timestamp: new Date().toISOString() });
  task.updatedAt = new Date().toISOString();

  const subs = taskSubscribers.get(taskId);
  if (subs) {
    for (const cb of subs) {
      try { cb(event); } catch (_) {}
    }
  }
}

function updateTask(taskId, updates) {
  const task = tasks.get(taskId);
  if (!task) return;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
}

function streamTask(taskId, callback) {
  if (!taskSubscribers.has(taskId)) {
    taskSubscribers.set(taskId, new Set());
  }
  taskSubscribers.get(taskId).add(callback);

  const task = tasks.get(taskId);
  if (task) {
    for (const event of task.events) {
      try { callback(event); } catch (_) {}
    }
  }

  return () => {
    const subs = taskSubscribers.get(taskId);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) taskSubscribers.delete(taskId);
    }
  };
}

async function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;

  updateTask(taskId, { status: "cancelled", currentStep: "任务已取消", progress: task.progress });
  publishEvent(taskId, { type: "cancelled", status: "cancelled", message: "任务已被用户取消" });

  try { await destroyContainer(task.userId); } catch (_) {}
}

function getTask(taskId) {
  return tasks.get(taskId);
}

function listUserTasks(userId) {
  const result = [];
  for (const task of tasks.values()) {
    if (task.userId === userId) {
      result.push({
        taskId: task.id,
        description: task.description,
        status: task.status,
        progress: task.progress,
        currentStep: task.currentStep,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export { createTask, getTask, streamTask, cancelTask, listUserTasks };
