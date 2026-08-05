// server/migrations.js — Flyway-style SQL migration runner
// 启动时自动执行未应用的迁移，记录在 schema_migrations 表
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** 确保 schema_migrations 表存在，返回已应用的版本号列表 */
async function ensureMigrationTable(pool) {
  await pool.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version   VARCHAR(32) PRIMARY KEY,
    name      VARCHAR(256) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const [rows] = await pool.execute("SELECT version FROM schema_migrations ORDER BY version");
  return rows.map(r => r.version);
}

/** 扫描 migrations 目录，返回排序后的待执行文件列表 */
function scanMigrations() {
  try {
    return readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    console.log(`[migration] No migrations directory found at ${MIGRATIONS_DIR}`);
    return [];
  }
}

/** 执行单个迁移文件 */
async function runMigration(pool, filename) {
  const version = filename.split("_")[0];
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf-8");

  console.log(`[migration] Applying ${filename}...`);
  await pool.query(sql);
  await pool.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [version, filename]);
  console.log(`[migration] ${filename} applied successfully`);
}

/** 主入口：运行所有待执行迁移 */
export async function runMigrations(pool, databaseName) {
  if (databaseName) {
    await pool.execute(`USE \`${databaseName}\``);
  }
  const applied = await ensureMigrationTable(pool);
  const files = scanMigrations();

  if (files.length === 0) {
    console.log("[migration] No migration files found");
    return;
  }

  const pending = files.filter(f => {
    const version = f.split("_")[0];
    return !applied.includes(version);
  });

  if (pending.length === 0) {
    console.log(`[migration] All ${files.length} migrations already applied, up to date`);
    return;
  }

  console.log(`[migration] Found ${files.length} total, ${pending.length} pending: ${pending.join(", ")}`);

  for (const file of pending) {
    try {
      await runMigration(pool, file);
    } catch (err) {
      console.error(`[migration] FAILED: ${file} — ${err.message}`);
      throw err;
    }
  }

  console.log(`[migration] Done. ${pending.length} migrations applied`);
}
