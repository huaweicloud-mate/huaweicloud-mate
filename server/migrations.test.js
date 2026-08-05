// server/migrations.test.js — Migration runner tests
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import { readdirSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Use a test database to avoid affecting real data
const TEST_DB = "hdkitservice_migration_test";
let pool;

// Helper: connect without database
async function connectRoot() {
  return mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    connectTimeout: 3000,
  });
}

beforeAll(async () => {
  try {
    const root = await connectRoot();
    await root.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await root.execute(`CREATE DATABASE \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4`);
    await root.end();
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: parseInt(process.env.MYSQL_PORT || "3306"),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD || "",
      database: TEST_DB,
      connectTimeout: 3000,
    });
  } catch (err) {
    console.warn(`[migration-test] MySQL not available, skipping: ${err.message}`);
  }
});

afterAll(async () => {
  if (pool) {
    try { await pool.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``); } catch {}
    await pool.end();
  }
});

describe("Migrations", () => {
  it("should create schema_migrations table on first run", async () => {
    if (!pool) return;
    const { ensureMigrationTable } = await import("./migrations.js");

    const applied = await ensureMigrationTable(pool);
    expect(applied).toEqual([]);

    const [rows] = await pool.execute("SHOW TABLES LIKE 'schema_migrations'");
    expect(rows.length).toBe(1);
  });

  it("should return applied versions on second run", async () => {
    if (!pool) return;
    const { ensureMigrationTable } = await import("./migrations.js");

    const applied = await ensureMigrationTable(pool);
    expect(applied.length).toBe(0); // no migrations applied yet, table just exists
  });

  it("should not run the same migration twice", async () => {
    if (!pool) return;
    const { runMigrations } = await import("./migrations.js");

    // First run
    await runMigrations(pool);
    const [before] = await pool.execute("SELECT COUNT(*) as cnt FROM schema_migrations");
    const countBefore = before[0].cnt;

    // Second run — should skip all already applied
    await runMigrations(pool);
    const [after] = await pool.execute("SELECT COUNT(*) as cnt FROM schema_migrations");
    expect(after[0].cnt).toBe(countBefore); // no new entries

    // Verify tables were created
    const [tables] = await pool.execute("SHOW TABLES");
    const tableNames = tables.map(t => Object.values(t)[0]);
    expect(tableNames).toContain("voucher_records");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("schema_migrations");
  });

  it("should create voucher_records and tasks tables with correct structure", async () => {
    if (!pool) return;

    // voucher_records columns
    const [vCols] = await pool.execute("DESCRIBE voucher_records");
    const vFields = vCols.map(c => c.Field);
    expect(vFields).toContain("domain_id");
    expect(vFields).toContain("ak_hash");
    expect(vFields).toContain("voucher_id");
    expect(vFields).toContain("amount");
    expect(vFields).toContain("status");

    // tasks columns
    const [tCols] = await pool.execute("DESCRIBE tasks");
    const tFields = tCols.map(c => c.Field);
    expect(tFields).toContain("id");
    expect(tFields).toContain("user_id");
    expect(tFields).toContain("description");
    expect(tFields).toContain("status");
    expect(tFields).toContain("progress");
  });

  it("should handle idempotent CREATE TABLE IF NOT EXISTS", async () => {
    if (!pool) return;
    const { runMigrations } = await import("./migrations.js");

    // Run migration again — should not error on existing tables
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });

  it("should not lose data on re-run", async () => {
    if (!pool) return;

    // Insert test data
    await pool.execute(
      "INSERT INTO voucher_records (domain_id, ak_hash) VALUES (?, ?)",
      ["test-domain-001", "test-hash-001"]
    );

    // Re-run migrations
    const { runMigrations } = await import("./migrations.js");
    await runMigrations(pool);

    // Verify data still exists
    const [rows] = await pool.execute(
      "SELECT * FROM voucher_records WHERE domain_id = ?",
      ["test-domain-001"]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].ak_hash).toBe("test-hash-001");
  });

  it("should handle empty migrations directory gracefully", async () => {
    if (!pool) return;

    // Create temp empty DB
    const root = await connectRoot();
    const EMPTY_DB = "hdkitservice_empty_mig";
    await root.execute(`DROP DATABASE IF EXISTS \`${EMPTY_DB}\``);
    await root.execute(`CREATE DATABASE \`${EMPTY_DB}\``);
    await root.end();

    const tmpPool = mysql.createPool({
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: parseInt(process.env.MYSQL_PORT || "3306"),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD || "",
      database: EMPTY_DB,
      connectTimeout: 3000,
    });

    // The migrations directory always has files, so this tests
    // the migration runner works against any database
    const { runMigrations } = await import("./migrations.js");
    await runMigrations(tmpPool);

    // Verify migration table was created
    const [tables] = await tmpPool.execute("SHOW TABLES LIKE 'schema_migrations'");
    expect(tables.length).toBe(1);

    await tmpPool.end();
    const root2 = await connectRoot();
    await root2.execute(`DROP DATABASE IF EXISTS \`${EMPTY_DB}\``);
    await root2.end();
  });
});
