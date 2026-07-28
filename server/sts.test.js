import { describe, it, expect } from "vitest";

describe("Q8: no printf pipe hack for hcloud CLI", () => {
  it("sts.js should not use printf pipe hack", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./sts.js", import.meta.url), "utf-8");
    expect(code).not.toMatch(/printf.*\|.*hcloud/);
  });

  it("hcloud commands should use --agree-privacy-policy flag", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./sts.js", import.meta.url), "utf-8");
    const hcloudCalls = code.match(/hcloud\s+\S+/g) || [];
    for (const call of hcloudCalls) {
      if (call.includes("configure set") || call.includes("IAM CreateTemporary")) {
        const lineStart = code.indexOf(call);
        const lineEnd = code.indexOf("\n", lineStart);
        const fullLine = code.slice(lineStart, lineEnd);
        expect(fullLine).toContain("--agree-privacy-policy=true");
      }
    }
  });

  it("AK should be passed via env or flag, not in printf pipe", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./sts.js", import.meta.url), "utf-8");
    expect(code).not.toMatch(/printf.*--cli-access-key/);
  });
});
