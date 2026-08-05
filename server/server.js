// cloud-server/server.js — A2A Server + MCP
// 华为云 Agent 插件后端，所有持久化走 DCS/MYSQL
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { authFlexible, issueJwt, generateLoginCode, confirmLoginCode, pollLoginCode, registerUser, isRedisAvailable, CODE_TTL_MS, verifyJwt } from "./auth.js";
import { createTask, getTask, streamTask, cancelTask, listUserTasks, initTaskCache } from "./task-manager.js";
import { getConcurrencyStats, reconcileActiveJobs, startSandboxGC } from "./sandbox.js";
import { checkSchema, initPool } from "./db.js";
import { getAgentCard } from "./agent-card.js";
import { countUsers, ensureRedis } from "./redis-store.js";
import { mcpRouter } from "./mcp-routes.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb", protoAction: "remove", constructorAction: "remove" }));
app.use((req, res, next) => {
  if (req.path === "/mcp" && req.method === "POST" && req.body?.params?.arguments?.token) {
    const payload = verifyJwt(req.body.params.arguments.token);
    if (payload) req.userId = payload.sub;
  }
  next();
});
app.use(rateLimit({ windowMs: 60000, max: 300, keyGenerator: (req) => req.userId || req.ip }));

// ── AgentCard ──
app.get("/.well-known/agent.json", (req, res) => res.setHeader("Cache-Control", "public, max-age=3600").json(getAgentCard()));

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
  const lastEventId = parseInt(req.headers["last-event-id"] || "0", 10);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const unsubscribe = streamTask(req.params.id, (event) => {
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    if (["completed", "failed", "cancelled"].includes(event.status)) { res.end(); unsubscribe(); }
  }, lastEventId);
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
const registerLimiter = rateLimit({ windowMs: 3600000, max: 10, keyGenerator: (req) => req.ip, message: { error: "注册请求过于频繁，请稍后再试" } });

app.post("/api/v1/register", registerLimiter, async (req, res) => {
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
  const schema = await checkSchema().catch(() => ({ ok: false }));
  res.json({ status: "ok", agent: getAgentCard().name, redis: isRedisAvailable(), db: schema, users: await countUsers(), uptime: process.uptime() });
});

// ── 二维码登录 ──
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tplSuccess = readFile(join(__dirname, "templates", "confirm-success.html"), "utf-8");
const tplExpired = readFile(join(__dirname, "templates", "confirm-expired.html"), "utf-8");

app.get("/auth/qr/:code.png", async (req, res) => {
  try { const img = await readFile(`/tmp/qrcode-login-${req.params.code}.png`); res.setHeader("Content-Type", "image/png"); res.send(img); } catch { res.status(404).send("QR not found"); }
});

const loginLimiter = rateLimit({ windowMs: 60000, max: 20, keyGenerator: (req) => req.ip, message: { error: "登录请求过于频繁" } });

app.post("/auth/login", loginLimiter, (req, res) => { const code = generateLoginCode(); res.json({ code, expiresIn: CODE_TTL_MS / 1000 }); });

app.get("/auth/confirm/:code", async (req, res) => {
  const token = await confirmLoginCode(req.params.code);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (token) { res.send(await tplSuccess); }
  else { res.status(404).send(await tplExpired); }
});

app.get("/auth/token/:code", (req, res) => { res.json(pollLoginCode(req.params.code)); });

// ── 激励 Mock ──
app.get("/api/v1/incentive/voucher/status", (req, res) => res.json({ claimed: false }));
app.post("/api/v1/incentive/voucher/claim", (req, res) => res.json({ success: true, voucherId: `vc_${Date.now()}`, amount: 100, currency: "CNY", expiredAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() }));

mcpRouter(app);

const server = app.listen(PORT, async () => {
  await initPool();
  await ensureRedis();
  console.log(`[A2A Server] 华为云 Agent 已启动 @ http://0.0.0.0:${PORT}`);
  console.log(`[A2A Server] AgentCard @ http://0.0.0.0:${PORT}/.well-known/agent.json`);
  await reconcileActiveJobs();
  await initTaskCache();
  startSandboxGC();
});

server.keepAliveTimeout = 30000;   // 30s，防止 ELB 过早断开
server.headersTimeout = 31000;     // 比 keepAliveTimeout 稍大
