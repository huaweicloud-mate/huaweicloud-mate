// cloud-server/db.js — MySQL RDS 数据库操作 (代金券 + 任务)
import mysql from "mysql2/promise";
import crypto from "node:crypto";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "mysql",
  port: parseInt(process.env.MYSQL_PORT || "3306"),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "hdkitservice",
  waitForConnections: true,
  connectionLimit: 5,
});

// 建表
pool.execute(`CREATE TABLE IF NOT EXISTS voucher_records (
  domain_id  VARCHAR(32)  PRIMARY KEY,
  ak_hash    VARCHAR(64)  NOT NULL,
  voucher_id VARCHAR(64),
  amount     INT          DEFAULT 100,
  status     TINYINT      DEFAULT 1,
  claimed_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ak_hash (ak_hash)
)`).catch((err) => { console.error(`[db] CREATE TABLE voucher_records failed: ${err.message}`); });

pool.execute(`CREATE TABLE IF NOT EXISTS tasks (
  id          VARCHAR(36)  PRIMARY KEY,
  user_id     VARCHAR(16)  NOT NULL,
  description TEXT         NOT NULL,
  status      VARCHAR(16)  DEFAULT 'pending',
  progress    INT          DEFAULT 0,
  output      MEDIUMTEXT,
  error       TEXT,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status)
)`).catch((err) => { console.error(`[db] CREATE TABLE tasks failed: ${err.message}`); });

// ── 代金券 ──

export async function getDomainId(ak, sk) {
  try {
    const region = "cn-south-1";
    const host = `iam.${region}.myhuaweicloud.com`;
    const path = "/v3/auth/domains";
    const method = "GET";
    const t = new Date();
    const ts = t.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const body = "";
    const sha256 = (d) => crypto.createHash("sha256").update(d).digest("hex");
    const hmacSha256 = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

    const canonicalHeaders = `host:${host}\nx-sdk-date:${ts}\n`;
    const signedHeaders = "host;x-sdk-date";
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
    const datestamp = t.toISOString().slice(0, 10).replace(/-/g, "");
    const scope = `${datestamp}/${region}/iam/sdk_request`;
    const stringToSign = `SDK-HMAC-SHA256\n${ts}\n${scope}\n${sha256(canonicalRequest)}`;
    const kDate = hmacSha256(sk, datestamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, "iam");
    const kSigning = hmacSha256(kService, "sdk_request");
    const sig = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const auth = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

    const resp = await fetch(`https://${host}${path}`, { method, headers: { "X-Sdk-Date": ts, "Authorization": auth } });
    const data = await resp.json();
    return data?.domains?.[0]?.id || null;
  } catch { return null; }
}

export async function getVoucher(domainId) {
  const [rows] = await pool.execute("SELECT * FROM voucher_records WHERE domain_id = ?", [domainId]);
  return rows[0] || null;
}

export async function claimVoucher(domainId, akHash, voucherId, amount) {
  await pool.execute("INSERT INTO voucher_records (domain_id, ak_hash, voucher_id, amount, status) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE voucher_id=?, amount=?, status=1",
    [domainId, akHash, voucherId, amount, voucherId, amount]);
}

export async function markVoucherClaimed(domainId, akHash) {
  await pool.execute("INSERT INTO voucher_records (domain_id, ak_hash, status) VALUES (?, ?, 2) ON DUPLICATE KEY UPDATE status=IF(status=1, 1, 2)", [domainId, akHash]);
}

// ── 任务 ──

export async function insertTask(task) {
  await pool.execute(
    "INSERT INTO tasks (id, user_id, description, status, progress, output, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [task.id, task.userId, task.description, task.status, task.progress, task.output || "", task.error || null]
  );
}

const TASK_UPDATE_WHITELIST = new Set(["status", "progress", "output", "error", "currentStep"]);

export async function updateTaskDb(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!TASK_UPDATE_WHITELIST.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v ?? null);
  }
  if (sets.length === 0) return;
  vals.push(id);
  await pool.execute(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function getTaskDb(id) {
  const [rows] = await pool.execute("SELECT * FROM tasks WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, userId: r.user_id, description: r.description, status: r.status, progress: r.progress, output: r.output, error: r.error, createdAt: r.created_at?.toISOString?.() || r.created_at, updatedAt: r.updated_at?.toISOString?.() || r.updated_at };
}

export async function listTasksByUser(userId) {
  const [rows] = await pool.execute("SELECT id, status, description, progress, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [userId]);
  return rows.map(r => ({ id: r.id, status: r.status, description: r.description, progress: r.progress, createdAt: r.created_at }));
}

export async function checkSchema() {
  const results = {};
  try {
    const [tables] = await pool.execute("SHOW TABLES");
    const tableNames = tables.map((t) => Object.values(t)[0]);
    results.voucher_records = tableNames.includes("voucher_records");
    results.tasks = tableNames.includes("tasks");
    results.ok = results.voucher_records && results.tasks;
  } catch (err) {
    results.ok = false;
    results.error = err.message;
  }
  return results;
}
