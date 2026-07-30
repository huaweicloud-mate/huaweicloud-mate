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

describe("CX-31: long-term to temp credential switch", () => {
  it("sts.js IAM command should redirect stderr to /dev/null", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./sts.js", import.meta.url), "utf-8");
    const iamLine = code.match(/hcloud IAM CreateTemporaryAccessKeyByToken[^\n]+/);
    expect(iamLine).not.toBeNull();
    expect(iamLine[0]).toMatch(/2>\/dev\/null/);
  });

  it("sts.js should filter non-JSON lines before matching credential", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./sts.js", import.meta.url), "utf-8");
    expect(code).toContain("cleanLines");
    expect(code).toMatch(/startsWith\("\{"\)/);
  });

  it("mcp-routes.js should destroy old sandbox before creating temp-cred sandbox", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const preheatSection = code.slice(code.indexOf("预热沙箱"));
    expect(preheatSection).toContain("destroyContainer");
    const destroyIdx = preheatSection.indexOf("await destroyContainer");
    const createIdx = preheatSection.indexOf("await getOrCreateContainer");
    expect(destroyIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(destroyIdx);
  });

  it("destroyContainer should only run when tempCreds exists", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const preheatSection = code.slice(code.indexOf("预热沙箱"));
    expect(preheatSection).toMatch(/if\s*\(\s*tempCreds\s*\)/);
  });
});
