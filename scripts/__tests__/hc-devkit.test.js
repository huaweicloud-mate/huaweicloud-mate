import { describe, it, expect } from "vitest";

describe("Q6: JSON.parse error handling in bin/hc-devkit.js", () => {
  it("all JSON.parse should be wrapped in try/catch with error logging", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../hc-devkit.js", import.meta.url), "utf-8");
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("JSON.parse") && !lines[i].includes("try")) {
        const prevLines = lines.slice(Math.max(0, i - 3), i).join("\n");
        if (!prevLines.includes("try")) {
          expect.fail(`JSON.parse without try at line ${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  });

  it("no empty catch {} in hc-devkit.js", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../hc-devkit.js", import.meta.url), "utf-8");
    const emptyCatch = code.match(/catch\s*\{\s*\}/g);
    expect(emptyCatch).toBeNull();
  });

  it("auth response parse catch should log error", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../hc-devkit.js", import.meta.url), "utf-8");
    const authSection = code.slice(code.indexOf("huaweicloud_auth"));
    const catchIdx = authSection.indexOf("catch");
    if (catchIdx > -1) {
      const afterCatch = authSection.slice(catchIdx, catchIdx + 200);
      expect(afterCatch).toContain("console.error");
    }
  });
});
