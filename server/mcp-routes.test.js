import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

describe("B2: voucher claim no self-referencing fetch", () => {
  it("mcp-routes.js should not contain 127.0.0.1 fetch loop", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const lines = code.split("\n");
    const violations = [];
    lines.forEach((line, i) => {
      if (line.includes("127.0.0.1") && line.includes("fetch") && line.includes("voucher/claim")) {
        violations.push({ line: i + 1, content: line.trim() });
      }
    });
    expect(violations).toHaveLength(0);
  });

  it("voucher claim should call claimVoucher directly, not fetch", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const claimSection = code.slice(code.indexOf("huaweicloud_voucher_claim"));
    expect(claimSection).toContain("claimVoucher(");
    expect(claimSection).not.toMatch(/fetch\(.+voucher\/claim/);
  });

  it("voucherId should be generated inline, not from external response", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const claimSection = code.slice(code.indexOf("huaweicloud_voucher_claim"));
    expect(claimSection).toMatch(/voucherId\s*=\s*`vc_\$\{Date\.now\(\)\}`/);
  });

  it("markVoucherClaimed should be in catch block as fallback", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const claimSection = code.slice(code.indexOf("huaweicloud_voucher_claim"));
    const catchIdx = claimSection.indexOf("catch");
    const markIdx = claimSection.indexOf("markVoucherClaimed");
    expect(catchIdx).toBeGreaterThan(0);
    expect(markIdx).toBeGreaterThan(catchIdx);
  });
});

describe("B6: unknown tool should not fallthrough to invoke", () => {
  it("non-invoke tool name should return error code -32601", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    expect(invokeSection).toContain("code:-32601");
    expect(invokeSection).toContain("Unknown tool");
  });

  it("unknown tool check should come before invoke logic", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const unknownCheck = code.indexOf('name !== "huaweicloud_invoke"');
    const invokeLogic = code.indexOf("const intent =");
    expect(unknownCheck).toBeGreaterThan(0);
    expect(invokeLogic).toBeGreaterThan(unknownCheck);
  });
});

describe("Q10: temp_credential loose comparison", () => {
  it("useTemp should accept boolean true, string 'true', and number 1", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const useTempLine = code.match(/const useTemp\s*=\s*[^;]+;/);
    expect(useTempLine).not.toBeNull();
    expect(useTempLine[0]).toContain("=== true");
    expect(useTempLine[0]).toContain('=== "true"');
    expect(useTempLine[0]).toContain("=== 1");
  });

  it("useTemp should not use strict === true only", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    expect(code).not.toMatch(/temp_credential\s*===\s*true\s*;/);
  });
});
