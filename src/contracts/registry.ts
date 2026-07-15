import { readFile } from "node:fs/promises";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import {
  contractFileNames,
  contractIds,
  type ContractFileName,
} from "./manifest.js";

type JsonSchema = Record<string, unknown>;
const maxContractDocumentBytes = 4 * 1024 * 1024;

const addFormats = (
  "default" in addFormatsModule
    ? addFormatsModule.default
    : addFormatsModule
) as unknown as FormatsPlugin;

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export type ContractJsonDocuments = Readonly<
  Record<ContractFileName, string>
>;

function asDirectoryUrl(url: URL): URL {
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ContractRegistry {
  readonly #ajv: Ajv2020;

  private constructor(ajv: Ajv2020) {
    this.#ajv = ajv;
  }

  static async load(
    directory = new URL("./schema/", import.meta.url),
  ): Promise<ContractRegistry> {
    const baseUrl = asDirectoryUrl(directory);
    const documents = Object.fromEntries(
      await Promise.all(
        contractFileNames.map(async (fileName) => [
          fileName,
          await readFile(new URL(fileName, baseUrl), "utf8"),
        ] as const),
      ),
    ) as Record<ContractFileName, string>;
    return ContractRegistry.fromJsonDocuments(documents);
  }

  static fromJsonDocuments(documents: unknown): ContractRegistry {
    if (
      typeof documents !== "object" ||
      documents === null ||
      Array.isArray(documents) ||
      Object.keys(documents).sort().join("\n") !==
        [...contractFileNames].sort().join("\n")
    ) {
      throw new TypeError("Contract document set is incomplete or has extra fields");
    }
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
    });
    addFormats(ajv);

    for (const fileName of contractFileNames) {
      const text = (documents as Record<string, unknown>)[fileName];
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text, "utf8") <= 0 ||
        Buffer.byteLength(text, "utf8") > maxContractDocumentBytes
      ) {
        throw new TypeError(`Contract ${fileName} is not bounded JSON text`);
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new TypeError(`Contract ${fileName} is not valid JSON`);
      }
      if (!isJsonSchema(value)) {
        throw new TypeError(`Contract ${fileName} is not a JSON object`);
      }

      const expectedId = contractIds[fileName];
      if (value.$id !== expectedId) {
        throw new Error(
          `Contract ${fileName} has unexpected $id ${String(value.$id)}; expected ${expectedId}`,
        );
      }
      ajv.addSchema(value, expectedId);
    }

    const registry = new ContractRegistry(ajv);
    registry.compileAll();
    return registry;
  }

  compileAll(): ReadonlyMap<ContractFileName, ValidateFunction> {
    return new Map(
      contractFileNames.map((fileName) => [fileName, this.validator(fileName)]),
    );
  }

  validator(fileName: ContractFileName): ValidateFunction {
    const validator = this.#ajv.getSchema(contractIds[fileName]);
    if (validator === undefined) {
      throw new Error(`Contract ${fileName} is not registered`);
    }
    return validator;
  }

  validate(
    fileName: ContractFileName,
    instance: unknown,
  ): ContractValidationResult {
    const validator = this.validator(fileName);
    const valid = validator(instance);
    return {
      valid,
      errors: validator.errors === null || validator.errors === undefined
        ? []
        : [...validator.errors],
    };
  }
}
