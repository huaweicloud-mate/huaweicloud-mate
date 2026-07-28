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
