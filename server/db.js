// server/db.js — MySQL RDS + Flyway-style migration runner
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { runMigrations } from "./migrations.js";

const DB_NAME = process.env.MYSQL_DATABASE || "hdkitservice";

let pool;

export async function initPool() {
  const init = mysql.createPool({
    host: process.env.MYSQL_HOST || "mysql",
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD,
    connectTimeout: 10000,
  });

  await init.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4`);
  await runMigrations(init, DB_NAME);
  await init.end();

  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "mysql",
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
  });
  console.log("[db] Pool initialized, migrations up to date");
  return pool;
}

export function getPool() {
  if (!pool) throw new Error("[db] Pool not initialized. Call initPool() first.");
  return pool;
}

// ── Schema Check ──
export async function checkSchema() {
  try {
    const [r1] = await p().execute("SELECT 1 FROM voucher_records LIMIT 1");
    const [r2] = await p().execute("SELECT 1 FROM tasks LIMIT 1");
    return { ok: true, tables: { voucher_records: true, tasks: true } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── 代金券 ──
export async function getDomainId(ak, sk) {
  const { execSync } = await import("node:child_process");
  const cmd = [
    "printf 'y\\n' | hcloud IAM KeystoneListAuthDomains",
    "--cli-region=cn-south-1",
    `--cli-access-key=${ak}`,
    `--cli-secret-key=${sk}`,
    "2>/dev/null",
  ].join(" ");
  try {
    const raw = execSync(cmd, { timeout: 5000, killSignal: "SIGKILL" }).toString();
    const match = raw.match(/"id"\s*:\s*"([a-f0-9]+)"/);
    return match ? match[1] : null;
  } catch (err) {
    console.error(`[db] getDomainId failed: ${err.message}`);
    throw err;
  }
}

export async function getVoucher(domainId) {
  const [rows] = await p().execute("SELECT * FROM voucher_records WHERE domain_id = ?", [domainId]);
  return rows[0] || null;
}

export async function claimVoucher(domainId, akHash, voucherId, amount) {
  await p().execute(
    `INSERT INTO voucher_records (domain_id, ak_hash, voucher_id, amount, status)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       voucher_id = IF(status = 1, voucher_id, VALUES(voucher_id)),
       amount     = IF(status = 1, amount, VALUES(amount)),
       status     = IF(status = 1, 1, 2),
       claimed_at = IF(status = 1, claimed_at, CURRENT_TIMESTAMP)`,
    [domainId, akHash, voucherId, amount]
  );
}

export async function markVoucherClaimed(domainId, akHash) {
  await p().execute(
    `INSERT INTO voucher_records (domain_id, ak_hash, status)
     VALUES (?, ?, 2)
     ON DUPLICATE KEY UPDATE
       ak_hash = IF(status = 1, ak_hash, VALUES(ak_hash)),
       status  = IF(status = 1, 1, 2)`,
    [domainId, akHash]
  );
}

// ── 任务管理 ──
const TASK_UPDATE_WHITELIST = new Set(["status", "progress", "currentStep", "output", "error", "artifacts"]);

export async function insertTask(task) {
  await p().execute(
    `INSERT INTO tasks (id, user_id, description, status, progress, currentStep)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [task.id, task.userId, task.description, task.status || "pending", task.progress || 0, task.currentStep || ""]
  );
}

export async function updateTaskDb(id, fields) {
  const entries = Object.entries(fields).filter(([k]) => TASK_UPDATE_WHITELIST.has(k));
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `\`${k}\` = ?`).join(", ");
  const values = entries.map(([, v]) => typeof v === "object" ? JSON.stringify(v) : v);
  await p().execute(`UPDATE tasks SET ${sets} WHERE id = ?`, [...values, id]);
}

export async function getTaskDb(id) {
  const [rows] = await p().execute("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!rows[0]) return null;
  const t = rows[0];
  return {
    id: t.id, userId: t.user_id || t.userId, description: t.description,
    status: t.status, progress: t.progress, currentStep: t.currentStep,
    output: t.output, error: t.error, artifacts: (() => { try { return typeof t.artifacts === "string" ? JSON.parse(t.artifacts) : t.artifacts; } catch { return t.artifacts; } })(),
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

export async function listTasksByUser(userId) {
  const [rows] = await p().execute("SELECT id, description, status, progress, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [userId]);
  return rows;
}
