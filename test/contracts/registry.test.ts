import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { contractFileNames } from "../../src/contracts/manifest.js";
import { ContractRegistry } from "../../src/contracts/registry.js";
import { runContractDoctor } from "../../src/doctor/contract-doctor.js";
import {
  referenceProviderDescriptor,
  referenceProviderHandshake,
} from "../fixtures/reference-provider.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

describe("M0 contract registry", () => {
  it("loads and compiles every canonical schema", async () => {
    const registry = await ContractRegistry.load(contractDirectory);

    expect([...registry.compileAll().keys()]).toEqual(contractFileNames);
  });

  it("matches every declared schema-layer vector expectation", async () => {
    const report = await runContractDoctor(contractDirectory);

    expect(report.ok).toBe(true);
    expect(report.schemaCount).toBe(7);
    expect(report.vectorCount).toBe(7);
    expect(report.deferredStateMachineVectorCount).toBe(3);
    expect(report.vectors.every((vector) => vector.passed)).toBe(true);
  });

  it("accepts the development-only reference provider contract fixtures", async () => {
    const registry = await ContractRegistry.load(contractDirectory);

    expect(
      registry.validate("provider-v1-lite.schema.json", referenceProviderDescriptor),
    ).toMatchObject({ valid: true, errors: [] });
    expect(
      registry.validate("provider-v1-lite.schema.json", referenceProviderHandshake),
    ).toMatchObject({ valid: true, errors: [] });
  });
});
