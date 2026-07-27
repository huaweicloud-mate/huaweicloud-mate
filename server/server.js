// cloud-server/server.js — A2A Server + MCP
// 华为云 Agent 插件后端，所有持久化走 DCS/MYSQL
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { authFlexible, issueJwt, generateLoginCode, confirmLoginCode, pollLoginCode, registerUser, isRedisAvailable } from "./auth.js";
import { createTask, getTask, streamTask, cancelTask, listUserTasks } from "./task-manager.js";
import { getConcurrencyStats, reconcileActiveJobs } from "./sandbox.js";
import { getAgentCard } from "./agent-card.js";
import { countUsers } from "./redis-store.js";
import { mcpRouter } from "./mcp-routes.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60000, max: 300, keyGenerator: (req) => req.userId || req.ip }));

// ── AgentCard ──
app.get("/.well-known/agent.json", (req, res) => res.json(getAgentCard()));

// ── 任务管理 ──
app.post("/tasks", authFlexible, async (req, res) => {
  const { description, context } = req.body;
  if (!description) return res.status(400).json({ error: "缺少 description" });
  try {
    const task = await createTask(req.userId, description, context || {}, req.user);
    const statusUrl = `/tasks/${task.id}`;
    res.status(201).header("Location", statusUrl).json({ taskId: task.id, status: task.status, statusUrl, streamUrl: `${statusUrl}/stream`, ...(req.issuedJwt ? { token: req.issuedJwt } : {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/tasks/:id", authFlexible, async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "无权查看" });
  res.json({ taskId: task.id, status: task.status, description: task.description, progress: task.progress, currentStep: task.currentStep, artifacts: task.artifacts, output: task.output, error: task.error, createdAt: task.createdAt, updatedAt: task.updatedAt, ...(req.issuedJwt ? { token: req.issuedJwt } : {}) });
});

app.get("/tasks/:id/stream", authFlexible, async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).end();
  if (task.userId !== req.userId) return res.status(403).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const unsubscribe = streamTask(req.params.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (["completed", "failed", "cancelled"].includes(event.status)) { res.end(); unsubscribe(); }
  });
  req.on("close", unsubscribe);
});

app.delete("/tasks/:id", authFlexible, async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  if (task.userId !== req.userId) return res.status(403).json({ error: "无权操作" });
  await cancelTask(req.params.id);
  res.json({ taskId: req.params.id, status: "cancelled" });
});

app.get("/tasks", authFlexible, async (req, res) => {
  const tasks = await listUserTasks(req.userId);
  res.json({ tasks, ...(req.issuedJwt ? { token: req.issuedJwt } : {}) });
});

// ── 用户注册 ──
app.post("/api/v1/register", async (req, res) => {
  const { userId, ak, sk, projectId, openaiKey, region } = req.body;
  if (!userId || !ak || !sk) return res.status(400).json({ error: "缺少 userId, ak, sk" });
  try {
    const result = await registerUser({ userId, ak, sk, projectId, openaiKey, region });
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.status(201).json({ ok: true, userId, token: issueJwt(userId) });
  } catch (err) { res.status(503).json({ error: err.message }); }
});

// ── 健康/统计 ──
app.get("/api/v1/concurrency", authFlexible, (req, res) => res.json(getConcurrencyStats()));

app.get("/api/v1/health", async (req, res) => {
  res.json({ status: "ok", agent: getAgentCard().name, redis: isRedisAvailable(), users: await countUsers(), uptime: process.uptime() });
});

// ── 二维码登录 ──
import { readFile } from "node:fs/promises";

app.get("/auth/qr/:code.png", async (req, res) => {
  try { const img = await readFile(`/tmp/qrcode-login-${req.params.code}.png`); res.setHeader("Content-Type", "image/png"); res.send(img); } catch { res.status(404).send("QR not found"); }
});

app.post("/auth/login", (req, res) => { const code = generateLoginCode(); res.json({ code, expiresIn: 30 }); });

app.get("/auth/confirm/:code", async (req, res) => {
  const token = await confirmLoginCode(req.params.code);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (token) { res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录成功</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}.box{background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}h2{color:#0a0;margin:0 0 12px}.done{font-weight:bold;font-size:18px}p{color:#666;margin:0}</style></head><body><div class="box"><h2 class="done">已确认</h2><p>返回终端继续操作</p></div></body></html>`); }
  else { res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认码无效</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}.box{background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}h2{color:#c00}p{color:#666}</style></head><body><div class="box"><h2>确认码无效或已过期</h2><p>请返回终端重新发起登录</p></div></body></html>`); }
});

app.get("/auth/token/:code", (req, res) => { res.json(pollLoginCode(req.params.code)); });

// ── 激励 Mock ──
app.get("/api/v1/incentive/voucher/status", (req, res) => res.json({ claimed: false }));
app.post("/api/v1/incentive/voucher/claim", (req, res) => res.json({ success: true, voucherId: `vc_${Date.now()}`, amount: 100, currency: "CNY", expiredAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() }));

mcpRouter(app);

app.listen(PORT, async () => {
  console.log(`[A2A Server] 华为云 Agent 已启动 @ http://0.0.0.0:${PORT}`);
  console.log(`[A2A Server] AgentCard @ http://0.0.0.0:${PORT}/.well-known/agent.json`);
  await reconcileActiveJobs();
});
