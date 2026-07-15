import { describe, expect, it } from "vitest";

import { redactedValue } from "../../src/router/redaction.js";
import { assertNoSensitiveOutput } from "../../src/router/sensitive-output.js";

describe("sensitive output guard", () => {
  it("accepts ordinary identifiers, pagination tokens, and signature metadata", () => {
    expect(() =>
      assertNoSensitiveOutput({
        requestId: "request-1",
        nextToken: "page-2",
        signatureAlgorithm: "SDK-HMAC-SHA256",
      }),
    ).not.toThrow();
  });

  it("accepts credential-shaped fields only after their values are redacted", () => {
    expect(() =>
      assertNoSensitiveOutput({
        credential: redactedValue,
        nested: { secretKey: redactedValue },
      }),
    ).not.toThrow();
  });

  it.each([
    { secretKey: "not-for-the-agent" },
    { nested: { routeToken: "opaque-route-token-value" } },
    { text: "Authorization: SDK-HMAC-SHA256 Access=example" },
    { url: "https://example.invalid/object?AccessKeyId=example&Signature=secret" },
    { key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key" },
  ])("rejects undeclared credential material", (value) => {
    expect(() => assertNoSensitiveOutput(value)).toThrowError(
      expect.objectContaining({
        code: "OUTPUT_REJECTED",
        message: "Executor result contains undeclared sensitive material",
      }),
    );
  });
});
