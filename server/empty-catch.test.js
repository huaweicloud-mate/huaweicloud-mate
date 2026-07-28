import { describe, it, expect } from "vitest";

const serverFiles = ["./mcp-routes.js", "./sandbox.js", "./auth.js", "./db.js", "./redis-store.js", "./sts.js", "./task-manager.js"];

describe("Q1: no empty catch blocks", () => {
  for (const file of serverFiles) {
    it(`${file} should have no empty catch {} or .catch(() => {})`, async () => {
      const fs = await import("node:fs/promises");
      let code;
      try { code = await fs.readFile(new URL(file, import.meta.url), "utf-8"); } catch { return; }
      const emptyCatchTry = code.match(/catch\s*\{\s*\}/g);
      const emptyCatchThen = code.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g);
      const total = (emptyCatchTry?.length || 0) + (emptyCatchThen?.length || 0);
      expect(total, `Found ${total} empty catch in ${file}`).toBe(0);
    });
  }
});

describe("Q2: all .catch() callbacks should log errors", () => {
  it("no .catch((err) => {}) with empty body in any server file", async () => {
    const fs = await import("node:fs/promises");
    for (const file of serverFiles) {
      let code;
      try { code = await fs.readFile(new URL(file, import.meta.url), "utf-8"); } catch { continue; }
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/\.catch\(\s*\(\s*\w+\s*\)\s*=>\s*\{\s*\}\s*\)/)) {
          expect.fail(`Silent .catch with empty body in ${file} line ${i + 1}`);
        }
      }
    }
  });

  it("every .catch with error param should have console.error or console.log in nearby lines", async () => {
    const fs = await import("node:fs/promises");
    for (const file of serverFiles) {
      let code;
      try { code = await fs.readFile(new URL(file, import.meta.url), "utf-8"); } catch { continue; }
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/\.catch\(\s*(?:async\s*)?\(\s*\w+\s*\)\s*=>\s*\{/)) {
          const nearby = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
          if (!nearby.includes("console.error") && !nearby.includes("console.log") && !nearby.includes("throw")) {
            expect.fail(`Silent .catch in ${file} line ${i + 1}: no console.error/log/throw in next 5 lines`);
          }
        }
      }
    }
  });
});

describe("Q9: Redis async connection startup window", () => {
  it("redis-store should export ensureRedis", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./redis-store.js", import.meta.url), "utf-8");
    expect(code).toContain("export async function ensureRedis");
  });

  it("ensureRedis should await redisConnectPromise before returning", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./redis-store.js", import.meta.url), "utf-8");
    const ensureFn = code.slice(code.indexOf("async function ensureRedis"));
    expect(ensureFn).toContain("redisConnectPromise");
    expect(ensureFn).toContain("await");
  });

  it("server.js should await ensureRedis before accepting requests", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./server.js", import.meta.url), "utf-8");
    const listenBlock = code.slice(code.indexOf("app.listen"));
    const logLine = listenBlock.indexOf("已启动");
    const ensureLine = listenBlock.indexOf("ensureRedis");
    expect(ensureLine).toBeGreaterThan(0);
    expect(ensureLine).toBeLessThan(logLine);
  });
});
