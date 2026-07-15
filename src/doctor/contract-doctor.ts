import { readFile } from "node:fs/promises";

import {
  contractFileNames,
  type ContractFileName,
} from "../contracts/manifest.js";
import { ContractRegistry } from "../contracts/registry.js";
import {
  runStateMachineDoctor,
  type StateMachineVector,
  type StateMachineVectorResult,
} from "./state-machine-doctor.js";

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
  readonly descriptorDigest?: string;
}

interface ContractVectorFile {
  readonly schemaVersion: string;
  readonly vectors: readonly ContractVector[];
  readonly stateMachineVectors: readonly StateMachineVector[];
}

export interface ContractVectorResult {
  readonly id: string;
  readonly expectation: string;
  readonly schemaValid: boolean;
  readonly semanticValid?: boolean;
  readonly passed: boolean;
  readonly errorCount: number;
}

export interface ContractDoctorReport {
  readonly ok: boolean;
  readonly schemaCount: number;
  readonly vectorCount: number;
  readonly stateMachineVectorCount: number;
  readonly deferredStateMachineVectorCount: number;
  readonly vectors: readonly ContractVectorResult[];
  readonly stateMachineVectors: readonly StateMachineVectorResult[];
}

function isContractFileName(value: string): value is ContractFileName {
  return contractFileNames.some((fileName) => fileName === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticValidity(vector: ContractVector): boolean {
  if (
    vector.targetSchema !== "provider-v1-lite.schema.json" ||
    typeof vector.descriptorDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(vector.descriptorDigest) ||
    !isRecord(vector.instance) ||
    typeof vector.instance.capabilityDigest !== "string"
  ) {
    throw new Error(`Vector ${vector.id} has no supported semantic validator`);
  }
  return vector.instance.capabilityDigest === vector.descriptorDigest;
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
    const semanticValid = vector.expectation === "semantic-reject"
      ? semanticValidity(vector)
      : undefined;
    return {
      id: vector.id,
      expectation: vector.expectation,
      schemaValid: validation.valid,
      passed:
        validation.valid === expectedValidity &&
        (vector.expectation !== "semantic-reject" || semanticValid === false),
      errorCount: validation.errors.length,
      ...(semanticValid === undefined ? {} : { semanticValid }),
    };
  });
  const stateMachineResults = await runStateMachineDoctor(
    vectors.stateMachineVectors,
    baseDirectory,
  );

  return {
    ok:
      results.every((result) => result.passed) &&
      stateMachineResults.every((result) => result.passed),
    schemaCount: registry.compileAll().size,
    vectorCount: results.length,
    stateMachineVectorCount: stateMachineResults.length,
    deferredStateMachineVectorCount: 0,
    vectors: results,
    stateMachineVectors: stateMachineResults,
  };
}
