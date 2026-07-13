import { readFile } from "node:fs/promises";

import {
  contractFileNames,
  type ContractFileName,
} from "../contracts/manifest.js";
import { ContractRegistry } from "../contracts/registry.js";

function expectedSchemaValidity(expectation: string): boolean {
  switch (expectation) {
    case "accept":
    case "accept-once":
    case "semantic-reject":
      return true;
    case "reject":
      return false;
    default:
      throw new Error(`Unknown contract vector expectation: ${expectation}`);
  }
}

interface ContractVector {
  readonly id: string;
  readonly targetSchema: ContractFileName;
  readonly expectation: string;
  readonly instance: unknown;
}

interface ContractVectorFile {
  readonly schemaVersion: string;
  readonly vectors: readonly ContractVector[];
  readonly stateMachineVectors: readonly unknown[];
}

export interface ContractVectorResult {
  readonly id: string;
  readonly expectation: string;
  readonly schemaValid: boolean;
  readonly passed: boolean;
  readonly errorCount: number;
}

export interface ContractDoctorReport {
  readonly ok: boolean;
  readonly schemaCount: number;
  readonly vectorCount: number;
  readonly deferredStateMachineVectorCount: number;
  readonly vectors: readonly ContractVectorResult[];
}

function isContractFileName(value: string): value is ContractFileName {
  return contractFileNames.some((fileName) => fileName === value);
}

async function readVectorFile(url: URL): Promise<ContractVectorFile> {
  const value = JSON.parse(await readFile(url, "utf8")) as ContractVectorFile;
  if (
    value.schemaVersion !== "huaweicloud-agent-m0-test-vectors/v1" ||
    !Array.isArray(value.vectors) ||
    !Array.isArray(value.stateMachineVectors)
  ) {
    throw new Error("Invalid M0 contract vector file");
  }
  return value;
}

export async function runContractDoctor(
  directory = new URL("../contracts/schema/", import.meta.url),
): Promise<ContractDoctorReport> {
  const baseDirectory = directory.href.endsWith("/")
    ? directory
    : new URL(`${directory.href}/`);
  const registry = await ContractRegistry.load(baseDirectory);
  const vectors = await readVectorFile(
    new URL("m0-contract-vectors.json", baseDirectory),
  );

  const results = vectors.vectors.map((vector): ContractVectorResult => {
    if (!isContractFileName(vector.targetSchema)) {
      throw new Error(
        `Vector ${vector.id} targets unknown contract ${String(vector.targetSchema)}`,
      );
    }

    const validation = registry.validate(vector.targetSchema, vector.instance);
    const expectedValidity = expectedSchemaValidity(vector.expectation);
    return {
      id: vector.id,
      expectation: vector.expectation,
      schemaValid: validation.valid,
      passed: validation.valid === expectedValidity,
      errorCount: validation.errors.length,
    };
  });

  return {
    ok: results.every((result) => result.passed),
    schemaCount: registry.compileAll().size,
    vectorCount: results.length,
    deferredStateMachineVectorCount: vectors.stateMachineVectors.length,
    vectors: results,
  };
}
