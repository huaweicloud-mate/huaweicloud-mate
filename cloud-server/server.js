// cloud-server/server.js — A2A Server（Agent-to-Agent 协议）
// 部署到华为云，暴露标准 A2A 接口
// 内部通过 Docker 沙箱运行 Codex CLI，CLI 可调用 koocli/MCP/Skills/API

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { authFlexible, authWithAkSk, issueJwt } from "./auth.js";
import { createTask, getTask, streamTask, cancelTask, listUserTasks } from "./task-manager.js";
import { getConcurrencyStats } from "./sandbox.js";
import { getAgentCard } from "./agent-card.js";
import { userStore } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60000, max: 120, keyGenerator: (req) => req.userId || req.ip }));

// ========== A2A 标准接口 ==========

// GET /.well-known/agent.json — AgentCard（云端能力声明）
app.get("/.well-known/agent.json", (req, res) => {
  res.json(getAgentCard());
});

// POST /tasks — 委托任务（核心入口）
// 本地 Agent 说"部署 Spring Boot"，云端 Agent 自己决定用什么工具
app.post("/tasks", authFlexible, async (req, res) => {
  const { description, context } = req.body;
  if (!description) return res.status(400).json({ error: "缺少 description" });

  try {
    const task = await createTask(req.userId, description, context || {}, req.user);
    const statusUrl = `/tasks/${task.id}`;

    res.status(201)
      .header("Location", statusUrl)
      .json({
        taskId: task.id,
        status: task.status,
        statusUrl,
        streamUrl: `${statusUrl}/stream`,
        ...(req.issuedJwt ? { token: req.issuedJwt } : {}),
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /tasks/:id — 查询任务状态
app.get("/tasks/:id", authFlexible, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "无权访问" });

  res.json({
    taskId: task.id,
    status: task.status,           // pending | working | completed | failed | cancelled
    description: task.description,
    progress: task.progress,        // 0-100
    currentStep: task.currentStep,  // "正在创建 ECS..."
    artifacts: task.artifacts,      // [{ name, url, description }]
    output: task.output,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(req.issuedJwt ? { token: req.issuedJwt } : {}),
  });
});

// GET /tasks/:id/stream — SSE 流式推送进度
app.get("/tasks/:id/stream", authFlexible, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).end();
  if (task.userId !== req.userId) return res.status(403).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const unsubscribe = streamTask(req.params.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
      res.end();
      unsubscribe();
    }
  });

  req.on("close", unsubscribe);
});

// DELETE /tasks/:id — 取消任务
app.delete("/tasks/:id", authFlexible, async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "无权访问" });

  await cancelTask(req.params.id);
  res.json({ taskId: req.params.id, status: "cancelled" });
});

// GET /tasks — 用户任务列表
app.get("/tasks", authFlexible, (req, res) => {
  const tasks = listUserTasks(req.userId);
  res.json({ tasks, ...(req.issuedJwt ? { token: req.issuedJwt } : {}) });
});

// ========== 用户注册 ==========

app.post("/api/v1/register", (req, res) => {
  const { userId, ak, sk, projectId, openaiKey, region } = req.body;
  if (!userId || !ak || !sk) {
    return res.status(400).json({ error: "缺少 userId, ak, sk" });
  }
  if (userStore.has(userId)) {
    return res.status(409).json({ error: "用户已存在" });
  }
  userStore.set(userId, { userId, ak, sk, projectId, openaiKey, createdAt: Date.now() });

  const token = issueJwt(userId);
  res.status(201).json({ ok: true, userId, token });
});

// ========== 健康检查 ==========

// GET /api/v1/concurrency — 并发状态
app.get("/api/v1/concurrency", authFlexible, (req, res) => {
  res.json(getConcurrencyStats());
});

app.get("/api/v1/health", (req, res) => {
  res.json({
    status: "ok",
    agent: getAgentCard().name,
    users: userStore.size,
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`[A2A Server] 华为云 Agent 已启动 → http://0.0.0.0:${PORT}`);
  console.log(`[A2A Server] AgentCard → http://0.0.0.0:${PORT}/.well-known/agent.json`);
});
