import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { contractFileNames } from "../../src/contracts/manifest.js";
import { ContractRegistry } from "../../src/contracts/registry.js";
import { runContractDoctor } from "../../src/doctor/contract-doctor.js";
import { runStateMachineDoctor } from "../../src/doctor/state-machine-doctor.js";
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

  it("compiles an exact in-memory set of canonical JSON documents", async () => {
    const documents = Object.fromEntries(
      await Promise.all(
        contractFileNames.map(async (fileName) => [
          fileName,
          await readFile(resolve("docs/契约", fileName), "utf8"),
        ] as const),
      ),
    );

    expect([
      ...ContractRegistry.fromJsonDocuments(documents).compileAll().keys(),
    ]).toEqual(contractFileNames);
    const { [contractFileNames[0]]: _missing, ...incomplete } = documents;
    expect(() => ContractRegistry.fromJsonDocuments(incomplete)).toThrow(
      "Contract document set is incomplete or has extra fields",
    );
    expect(() =>
      ContractRegistry.fromJsonDocuments({
        ...documents,
        [contractFileNames[0]]: JSON.stringify({ $id: "urn:wrong" }),
      }),
    ).toThrow("has unexpected $id");
  });

  it("matches every declared schema-layer vector expectation", async () => {
    const report = await runContractDoctor(contractDirectory);

    expect(report.ok).toBe(true);
    expect(report.schemaCount).toBe(7);
    expect(report.vectorCount).toBe(9);
    expect(report.stateMachineVectorCount).toBe(4);
    expect(report.deferredStateMachineVectorCount).toBe(0);
    expect(report.vectors.every((vector) => vector.passed)).toBe(true);
    expect(report.vectors.find(
      (vector) => vector.id === "provider-handshake-digest-mismatch-rejected",
    )).toMatchObject({ schemaValid: true, semanticValid: false, passed: true });
    expect(report.stateMachineVectors.every((vector) => vector.passed)).toBe(true);
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

  it("fails a state-machine vector whose frozen steps drift", async () => {
    const results = await runStateMachineDoctor(
      [{ id: "approval-replay", steps: [] }],
      contractDirectory,
    );

    expect(results).toEqual([
      expect.objectContaining({
        id: "approval-replay",
        passed: false,
        observed: ["VECTOR_SHAPE_MISMATCH"],
      }),
    ]);
  });
});
