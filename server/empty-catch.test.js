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
