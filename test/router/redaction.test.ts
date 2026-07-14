import { describe, expect, it } from "vitest";

import {
  redactJsonPointers,
  redactedValue,
} from "../../src/router/redaction.js";

describe("JSON Pointer output redaction", () => {
  it("redacts nested objects, arrays, and escaped pointer tokens", () => {
    const original = {
      credential: { secret: "do-not-return" },
      items: [{ token: "first" }, { token: "second" }],
      "a/b": { "m~n": "escaped" },
      visible: "keep",
    };

    const result = redactJsonPointers(original, [
      "/credential/secret",
      "/items/1/token",
      "/items/length",
      "/a~1b/m~0n",
      "/missing/path",
    ]);

    expect(result).toEqual({
      credential: { secret: redactedValue },
      items: [{ token: "first" }, { token: redactedValue }],
      "a/b": { "m~n": redactedValue },
      visible: "keep",
    });
    expect(original.credential.secret).toBe("do-not-return");
  });

  it("can redact the entire document", () => {
    expect(redactJsonPointers({ secret: "value" }, [""])).toBe(redactedValue);
  });

  it("redacts an own __proto__ key without changing object prototypes", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const result = redactJsonPointers(value, ["/__proto__"]);

    expect(result).toEqual(JSON.parse(`{"__proto__":"${redactedValue}"}`));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
