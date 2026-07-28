import { describe, it, expect } from "vitest";

describe("B5: markVoucherClaimed should not overwrite status=1", () => {
  it("ON DUPLICATE KEY UPDATE should use IF(status=1,1,2) to protect claimed records", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./db.js", import.meta.url), "utf-8");
    const markFn = code.slice(code.indexOf("async function markVoucherClaimed"));
    expect(markFn).toMatch(/IF\(status\s*=\s*1\s*,\s*1\s*,\s*2\)/);
  });

  it("markVoucherClaimed should not contain unconditional status=2 in UPDATE", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./db.js", import.meta.url), "utf-8");
    const markFn = code.slice(code.indexOf("async function markVoucherClaimed"));
    const updateClause = markFn.slice(markFn.indexOf("ON DUPLICATE KEY UPDATE"));
    expect(updateClause).not.toMatch(/UPDATE\s+status\s*=\s*2/);
  });

  it("claimVoucher should set status=1 correctly", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./db.js", import.meta.url), "utf-8");
    const claimFn = code.slice(code.indexOf("async function claimVoucher"));
    expect(claimFn).toContain("status=1");
  });
});
