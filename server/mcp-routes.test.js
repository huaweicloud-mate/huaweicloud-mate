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
