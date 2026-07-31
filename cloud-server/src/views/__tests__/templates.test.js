import { describe, it, expect } from "vitest";

describe("Q7: HTML templates extracted from JS", () => {
  it("server.js should not contain inline HTML DOCTYPE", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../../server.js", import.meta.url), "utf-8");
    expect(code).not.toMatch(/<!DOCTYPE html>/);
  });

  it("server.js should load templates from files", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../../server.js", import.meta.url), "utf-8");
    expect(code).toContain("tplSuccess");
    expect(code).toContain("tplExpired");
    expect(code).toContain("views");
  });

  it("confirm-success.html should exist and contain 已确认", async () => {
    const fs = await import("node:fs/promises");
    const html = await fs.readFile(new URL("../confirm-success.html", import.meta.url), "utf-8");
    expect(html).toContain("已确认");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("confirm-expired.html should exist and contain 确认码无效", async () => {
    const fs = await import("node:fs/promises");
    const html = await fs.readFile(new URL("../confirm-expired.html", import.meta.url), "utf-8");
    expect(html).toContain("确认码无效");
    expect(html).toContain("<!DOCTYPE html>");
  });
});
