import { describe, it, expect } from "vitest";

describe("B5: markVoucherClaimed should not overwrite status=1", () => {
  it("ON DUPLICATE KEY UPDATE should use IF(status=1,1,2) to protect claimed records", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const markFn = code.slice(code.indexOf("async function markVoucherClaimed"));
    expect(markFn).toMatch(/IF\(status\s*=\s*1\s*,\s*1\s*,\s*2\)/);
  });

  it("markVoucherClaimed should not contain unconditional status=2 in UPDATE", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const markFn = code.slice(code.indexOf("async function markVoucherClaimed"));
    const updateClause = markFn.slice(markFn.indexOf("ON DUPLICATE KEY UPDATE"));
    expect(updateClause).not.toMatch(/UPDATE\s+status\s*=\s*2/);
  });

  it("claimVoucher should set status=1 correctly", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const claimFn = code.slice(code.indexOf("async function claimVoucher"));
    expect(claimFn).toContain("status=1");
  });
});

describe("Q4: DB CREATE TABLE failure not silent", () => {
  it("CREATE TABLE .catch should log error, not be empty", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const createLines = code.match(/pool\.execute\(`CREATE TABLE[\s\S]*?\.catch\([^)]*\)\s*=>\s*\{[^}]*\}/g) || [];
    for (const block of createLines) {
      expect(block).toContain("console.error");
    }
  });

  it("checkSchema should be exported", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    expect(code).toContain("export async function checkSchema");
  });

  it("checkSchema should verify both tables exist", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const checkFn = code.slice(code.indexOf("async function checkSchema"));
    expect(checkFn).toContain("voucher_records");
    expect(checkFn).toContain("tasks");
    expect(checkFn).toContain("SHOW TABLES");
  });

  it("health endpoint should include db schema check", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../../server.js", import.meta.url), "utf-8");
    expect(code).toContain("checkSchema");
  });
});

describe("Q5: updateTaskDb field whitelist", () => {
  it("updateTaskDb should filter fields through whitelist", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const updateFn = code.slice(code.indexOf("async function updateTaskDb"), code.indexOf("async function getTaskDb"));
    expect(updateFn).toContain("TASK_UPDATE_WHITELIST.has");
  });

  it("whitelist should only allow safe columns", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const whitelistMatch = code.match(/TASK_UPDATE_WHITELIST\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
    expect(whitelistMatch).not.toBeNull();
    const allowed = whitelistMatch[1];
    expect(allowed).toContain("status");
    expect(allowed).toContain("progress");
    expect(allowed).toContain("output");
    expect(allowed).toContain("error");
    expect(allowed).not.toContain("id");
    expect(allowed).not.toContain("user_id");
  });

  it("whitelist should not contain dangerous columns like id or user_id", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../db.js", import.meta.url), "utf-8");
    const whitelistMatch = code.match(/TASK_UPDATE_WHITELIST\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
    const allowed = whitelistMatch[1];
    for (const col of ["id", "user_id", "description", "created_at"]) {
      expect(allowed).not.toContain(col);
    }
  });
});
