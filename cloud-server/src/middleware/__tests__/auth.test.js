import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySignature, CODE_TTL_MS } from "../auth.js";

const AK = "HPUARREPRFZ9BCWWMWYH";
const SK = "MNQxuUR5uH8Hsqr5JKi6ZGjn8vgtuCv84X8jdzJU";

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function signRequest({ method, path, query, headers, body, ak, sk }) {
  const timestamp = headers["x-sdk-date"];
  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(";");
  const headerLines = signedHeaders.split(";").filter(Boolean).map((h) => `${h}:${(headers[h] || "").trim()}`);
  const canonical = [method, path, query || "", ...headerLines, "", sha256Hex(body || "")].join("\n");
  const sts = ["SDK-HMAC-SHA256", timestamp, sha256Hex(canonical)].join("\n");
  const signingKey = hmacSha256(sk, hmacSha256(sk, timestamp));
  const signature = hmacSha256(signingKey, sts).toString("hex");
  const authHeader = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { ...headers, authorization: authHeader };
}

describe("verifySignature", () => {
  it("valid signature should pass", () => {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const baseHeaders = { host: "113.45.151.224:3000", "x-sdk-date": timestamp, "content-type": "application/json" };
    const signed = signRequest({ method: "POST", path: "/tasks", query: "", headers: baseHeaders, body: '{"description":"test"}', ak: AK, sk: SK });

    const result = verifySignature({ method: "POST", path: "/tasks", query: "", headers: signed, body: '{"description":"test"}', ak: AK, sk: SK });
    expect(result.ok).toBe(true);
  });

  it("tampered body should fail", () => {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const baseHeaders = { host: "113.45.151.224:3000", "x-sdk-date": timestamp, "content-type": "application/json" };
    const signed = signRequest({ method: "POST", path: "/tasks", query: "", headers: baseHeaders, body: '{"description":"test"}', ak: AK, sk: SK });

    const result = verifySignature({ method: "POST", path: "/tasks", query: "", headers: signed, body: '{"description":"tampered"}', ak: AK, sk: SK });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("签名验证失败");
  });

  it("wrong AK should fail", () => {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const baseHeaders = { host: "113.45.151.224:3000", "x-sdk-date": timestamp, "content-type": "application/json" };
    const signed = signRequest({ method: "POST", path: "/tasks", query: "", headers: baseHeaders, body: "{}", ak: AK, sk: SK });

    const result = verifySignature({ method: "POST", path: "/tasks", query: "", headers: signed, body: "{}", ak: "WRONG_AK", sk: SK });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("AK 不匹配");
  });

  it("missing X-Sdk-Date should fail", () => {
    const authHeader = `SDK-HMAC-SHA256 Access=${AK},SignedHeaders=host,Signature=abc`;
    const result = verifySignature({ method: "GET", path: "/tasks", query: "", headers: { authorization: authHeader, host: "x" }, body: "", ak: AK, sk: SK });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("X-Sdk-Date");
  });

  it("expired timestamp should fail", () => {
    const oldTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const baseHeaders = { host: "113.45.151.224:3000", "x-sdk-date": oldTimestamp, "content-type": "application/json" };
    const signed = signRequest({ method: "GET", path: "/tasks", query: "", headers: baseHeaders, body: "", ak: AK, sk: SK });

    const result = verifySignature({ method: "GET", path: "/tasks", query: "", headers: signed, body: "", ak: AK, sk: SK });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("时间偏差");
  });

  it("malformed Authorization header should fail", () => {
    const result = verifySignature({ method: "GET", path: "/", query: "", headers: { authorization: "Bearer junk" }, body: "", ak: AK, sk: SK });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("格式无效");
  });
});

describe("B7: CODE_TTL_MS consistency", () => {
  it("CODE_TTL_MS should be exported and equal 30000", () => {
    expect(CODE_TTL_MS).toBe(30000);
  });

  it("server.js should use CODE_TTL_MS / 1000 for expiresIn, not hardcoded 30", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../../server.js", import.meta.url), "utf-8");
    expect(code).toContain("CODE_TTL_MS / 1000");
    expect(code).not.toMatch(/expiresIn:\s*30\b/);
  });
});

describe("M6: pollLoginCode concurrent grace period", () => {
  it("pollLoginCode should use setTimeout grace period, not immediate delete", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../auth.js", import.meta.url), "utf-8");
    const pollFn = code.slice(code.indexOf("function pollLoginCode"), code.indexOf("export {"));
    expect(pollFn).toContain("setTimeout");
    expect(pollFn).toContain("CODE_GRACE_MS");
    const confirmedBlock = pollFn.slice(pollFn.indexOf("if (entry.confirmed)"));
    expect(confirmedBlock).not.toMatch(/^\s*loginCodeStore\.delete\(code\);\s*$/m);
  });

  it("grace period should only be set once (graceSet flag)", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../auth.js", import.meta.url), "utf-8");
    const pollFn = code.slice(code.indexOf("function pollLoginCode"), code.indexOf("export {"));
    expect(pollFn).toContain("graceSet");
  });

  it("CODE_GRACE_MS should be defined as 5000", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../auth.js", import.meta.url), "utf-8");
    expect(code).toMatch(/CODE_GRACE_MS\s*=\s*5000/);
  });
});
