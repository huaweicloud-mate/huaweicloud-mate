// cloud-server/task-manager.js — A2A 任务生命周期管理
// 接收任务 → 分配沙箱 → opencode 执行 → 返回结果

import crypto from "node:crypto";
import {
  getOrCreateContainer,
  execInContainer,
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

    const container = await getOrCreateContainer(user.userId, user.openaiKey, user);
    updateTask(taskId, { progress: 10, currentStep: "沙箱就绪，正在执行任务..." });
    publishEvent(taskId, { type: "progress", progress: 10, message: "沙箱就绪" });

    // 构建 opencode 命令（非交互模式）
    const escapedDesc = task.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const cmd = `opencode run "${escapedDesc}" --auto --model maas/glm-5.2 2>&1 | tee /workspace/output.txt`;

    updateTask(taskId, { progress: 20, currentStep: "opencode 正在执行任务..." });
    publishEvent(taskId, { type: "progress", progress: 20, message: "opencode 开始执行" });

    const result = await execInContainer(container, cmd);

    updateTask(taskId, {
      progress: 90,
      currentStep: "任务执行完成，正在整理结果...",
      output: result,
    });

    // 尝试读取 output.txt
    try {
      const outputFile = await execInContainer(container, "cat /workspace/output.txt 2>/dev/null || echo ''");
      if (outputFile.trim()) {
        task.output = outputFile.trim();
      }
    } catch (_) {}

    updateTask(taskId, {
      status: "completed",
      progress: 100,
      currentStep: "任务完成",
      output: task.output || result,
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
