import { describe, expect, it } from "vitest";
import type { ObsEnv } from "../src/config/env.js";
import { getOperationByToolName } from "../src/operations/inventory.js";
import { enforceOperationGate } from "../src/security/gates.js";

const baseEnv: ObsEnv = {
  accessKeyId: "ak",
  secretAccessKey: "sk",
  region: "cn-north-4",
  enableWrite: false,
  enableDelete: false,
  enableConfigWrite: false,
  previewBytes: 1024
};

describe("operation safety gates", () => {
  it("allows read operations by default", () => {
    const spec = getOperationByToolName("obs_list_buckets");
    expect(spec).toBeDefined();
    expect(() => enforceOperationGate(spec!, {}, baseEnv)).not.toThrow();
  });

  it("blocks write operations without write env", () => {
    const spec = getOperationByToolName("obs_put_object");
    expect(spec).toBeDefined();
    expect(() => enforceOperationGate(spec!, { bucket: "b", key: "k" }, baseEnv)).toThrow(/ENABLE_WRITE/);
  });

  it("blocks delete operations without delete env", () => {
    const spec = getOperationByToolName("obs_delete_object");
    expect(spec).toBeDefined();
    expect(() => enforceOperationGate(spec!, { bucket: "b", key: "k", confirm: "b/k" }, { ...baseEnv, enableWrite: true })).toThrow(/ENABLE_DELETE/);
  });

  it("requires exact confirmation for destructive object operations", () => {
    const spec = getOperationByToolName("obs_truncate_object");
    const env = { ...baseEnv, enableWrite: true, enableDelete: true };
    expect(spec).toBeDefined();
    expect(() => enforceOperationGate(spec!, { bucket: "b", key: "k", confirm: "b" }, env)).toThrow(/confirm="b\/k"/);
    expect(() => enforceOperationGate(spec!, { bucket: "b", key: "k", confirm: "b/k" }, env)).not.toThrow();
  });

  it("blocks config writes without config env", () => {
    const spec = getOperationByToolName("obs_set_bucket_cors");
    expect(spec).toBeDefined();
    expect(() => enforceOperationGate(spec!, { bucket: "b" }, { ...baseEnv, enableWrite: true })).toThrow(/CONFIG_WRITE/);
  });
});
