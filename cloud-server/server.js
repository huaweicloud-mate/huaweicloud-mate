// cloud-server/server.js �� A2A Server��Agent-to-Agent Э�飩
// ���𵽻�Ϊ�ƣ���¶��׼ A2A �ӿ�
// �ڲ�ͨ�� Docker ɳ������ Codex CLI��CLI �ɵ��� koocli/MCP/Skills/API

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { authFlexible, issueJwt, generateLoginCode, confirmLoginCode, pollLoginCode } from "./auth.js";
import { createTask, getTask, streamTask, cancelTask, listUserTasks } from "./task-manager.js";
import { getConcurrencyStats } from "./sandbox.js";
import { getAgentCard } from "./agent-card.js";
import { userStore } from "./auth.js";
import { mcpRouter } from "./mcp-routes.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60000, max: 120, keyGenerator: (req) => req.userId || req.ip }));

// ========== A2A ��׼�ӿ� ==========

// GET /.well-known/agent.json �� AgentCard���ƶ�����������
app.get("/.well-known/agent.json", (req, res) => {
  res.json(getAgentCard());
});

// POST /tasks �� ί�����񣨺�����ڣ�
// ���� Agent ˵"���� Spring Boot"���ƶ� Agent �Լ�������ʲô����
app.post("/tasks", authFlexible, async (req, res) => {
  const { description, context } = req.body;
  if (!description) return res.status(400).json({ error: "ȱ�� description" });

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

// GET /tasks/:id �� ��ѯ����״̬
app.get("/tasks/:id", authFlexible, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "���񲻴���" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "��Ȩ����" });

  res.json({
    taskId: task.id,
    status: task.status,           // pending | working | completed | failed | cancelled
    description: task.description,
    progress: task.progress,        // 0-100
    currentStep: task.currentStep,  // "���ڴ��� ECS..."
    artifacts: task.artifacts,      // [{ name, url, description }]
    output: task.output,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(req.issuedJwt ? { token: req.issuedJwt } : {}),
  });
});

// GET /tasks/:id/stream �� SSE ��ʽ���ͽ���
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

// DELETE /tasks/:id �� ȡ������
app.delete("/tasks/:id", authFlexible, async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "���񲻴���" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "��Ȩ����" });

  await cancelTask(req.params.id);
  res.json({ taskId: req.params.id, status: "cancelled" });
});

// GET /tasks �� �û������б�
app.get("/tasks", authFlexible, (req, res) => {
  const tasks = listUserTasks(req.userId);
  res.json({ tasks, ...(req.issuedJwt ? { token: req.issuedJwt } : {}) });
});

// ========== �û�ע�� ==========

app.post("/api/v1/register", (req, res) => {
  const { userId, ak, sk, projectId, openaiKey, region } = req.body;
  if (!userId || !ak || !sk) {
    return res.status(400).json({ error: "ȱ�� userId, ak, sk" });
  }
  if (userStore.has(userId)) {
    return res.status(409).json({ error: "�û��Ѵ���" });
  }
  userStore.set(userId, { userId, ak, sk, projectId, openaiKey, createdAt: Date.now() });

  const token = issueJwt(userId);
  res.status(201).json({ ok: true, userId, token });
});

// ========== ������� ==========

// GET /api/v1/concurrency �� ����״̬
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

// ========== 二维码登录 ==========

app.post("/auth/login", (req, res) => {
  const code = generateLoginCode();
  res.json({ code, expiresIn: 30 });
});

app.get("/auth/confirm/:code", (req, res) => {
  const token = confirmLoginCode(req.params.code);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (token) {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录成功</title><style>
body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.box{background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h2{color:#0a0;margin:0 0 12px}.done{font-weight:bold;font-size:18px}
p{color:#666;margin:0}
</style></head><body>
<div class="box"><h2 class="done">已确认</h2><p>返回终端继续操作</p></div>
</body></html>`);
  } else {
    res.status(404).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>确认码无效</title><style>
body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.box{background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h2{color:#c00}p{color:#666}
</style></head><body>
<div class="box"><h2>确认码无效或已过期</h2><p>请返回终端重新发起登录</p></div>
</body></html>`);
  }
});

app.get("/auth/token/:code", (req, res) => {
  const result = pollLoginCode(req.params.code);
  res.json(result);
});

mcpRouter(app);

app.listen(PORT, () => {
  console.log(`[A2A Server] ��Ϊ�� Agent ������ �� http://0.0.0.0:${PORT}`);
  console.log(`[A2A Server] AgentCard �� http://0.0.0.0:${PORT}/.well-known/agent.json`);
});
