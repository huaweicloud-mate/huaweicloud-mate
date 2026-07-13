import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

import {
  contractFileNames,
  contractIds,
  type ContractFileName,
} from "./manifest.js";

type JsonSchema = Record<string, unknown>;

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

function asDirectoryUrl(url: URL): URL {
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
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
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
    });
    addFormats(ajv);

    const baseUrl = asDirectoryUrl(directory);
    for (const fileName of contractFileNames) {
      const value = await readJson(new URL(fileName, baseUrl));
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
