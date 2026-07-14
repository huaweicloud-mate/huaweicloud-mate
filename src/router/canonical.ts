import { createHash } from "node:crypto";

import { RouterError } from "./errors.js";

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RouterError(
      "SCHEMA_MISMATCH",
      "Router parameters contain a non-finite number",
    );
  }
  return JSON.stringify(value);
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
        );
      return `{${entries.join(",")}}`;
    }
    default:
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Router parameters are not valid JSON data",
      );
  }
}

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex")}`;
}
