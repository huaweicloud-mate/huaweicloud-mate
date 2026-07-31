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

  it("voucherId should come from incentive API issueResult.couponId", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const claimSection = code.slice(code.indexOf("huaweicloud_voucher_claim"));
    expect(claimSection).toContain("issueResult.couponId");
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

describe("Q11: AgentCard cache headers", () => {
  it("agent.json endpoint should set Cache-Control header", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./server.js", import.meta.url), "utf-8");
    const agentLine = code.match(/app\.get\([^)]*agent\.json[^)]*\)[^;]+;/s);
    expect(agentLine).not.toBeNull();
    expect(agentLine[0]).toContain("Cache-Control");
  });

  it("Cache-Control should be public with max-age=3600", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./server.js", import.meta.url), "utf-8");
    expect(code).toMatch(/public.*max-age=3600/);
  });
});

describe("CX-7: invalid/expired token should not fallthrough to anonymous", () => {
  it("invoke with invalid token should return error, not anonymous response", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    expect(invokeSection).toContain("token无效或已过期");
  });

  it("invalid token check should come before anonymous fallback", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    const invalidCheck = invokeSection.indexOf("token无效或已过期");
    const anonymousFallback = invokeSection.indexOf("createAnonymousContainer");
    expect(invalidCheck).toBeGreaterThan(0);
    expect(anonymousFallback).toBeGreaterThan(invalidCheck);
  });
});

describe("CX-9: multi-region independent tokens", () => {
  it("auth should use ak:region as index key, not just ak", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const authSection = code.slice(code.indexOf("huaweicloud_auth"));
    expect(authSection).toContain("akRegionKey");
    expect(authSection).toMatch(/ak.*:.*region/);
  });

  it("redis-store akidx should include region in key", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./redis-store.js", import.meta.url), "utf-8");
    const setUserFn = code.slice(code.indexOf("async function setUser"), code.indexOf("async function delUser"));
    expect(setUserFn).toMatch(/akidx:.*region/);
  });

  it("redis-store delUser should include region in akidx key", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./redis-store.js", import.meta.url), "utf-8");
    const delUserFn = code.slice(code.indexOf("async function delUser"), code.indexOf("async function findUserIdByAk"));
    expect(delUserFn).toMatch(/akidx:.*region/);
  });

  it("different regions should produce different userId", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const authSection = code.slice(code.indexOf("huaweicloud_auth"));
    expect(authSection).toContain("findUserIdByAk(akRegionKey)");
  });
});

describe("CX-32: temp credential expiration check in invoke", () => {
  it("invoke should check temp_credential and temp_expires_at", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    expect(invokeSection).toContain("temp_credential");
    expect(invokeSection).toContain("temp_expires_at");
  });

  it("invoke should compare Date.now() with expiresAt", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    expect(invokeSection).toMatch(/Date\.now\(\)\s*>\s*expiresAt/);
  });

  it("expired temp credential should return re-auth prompt", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    expect(invokeSection).toContain("临时凭证已过期");
  });

  it("expiration check should come before sandbox creation", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./mcp-routes.js", import.meta.url), "utf-8");
    const invokeSection = code.slice(code.indexOf("huaweicloud_invoke"));
    const expireCheck = invokeSection.indexOf("临时凭证已过期");
    const sandboxCreate = invokeSection.indexOf("createTask");
    expect(expireCheck).toBeGreaterThan(0);
    expect(sandboxCreate).toBeGreaterThan(expireCheck);
  });
});
