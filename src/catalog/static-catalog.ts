import { ContractRegistry } from "../contracts/registry.js";
import { digestCanonicalJson } from "../router/canonical.js";
import { RouterError } from "../router/errors.js";
import type {
  RouterCapabilityDefinition,
  RouterCapabilityRegistration,
} from "../router/types.js";
import type {
  CapabilityCatalog,
  CapabilityDescribeInput,
  CapabilityDescribeOutput,
  CapabilitySearchInput,
  CapabilitySearchItem,
  CapabilitySearchOutput,
} from "./types.js";

interface CatalogCursor {
  readonly offset: number;
  readonly queryDigest: string;
}

function availableExecutors(
  capability: RouterCapabilityDefinition,
): CapabilitySearchItem["executors"] {
  const executors: ("provider-mcp" | "koocli")[] = [];
  if (capability.executors.providerMcp !== undefined) {
    executors.push("provider-mcp");
  }
  if (capability.executors.koocli !== undefined) {
    executors.push("koocli");
  }
  return executors;
}

function searchItem(capability: RouterCapabilityDefinition): CapabilitySearchItem {
  return {
    capabilityId: capability.capabilityId,
    product: capability.product,
    summary: capability.summary,
    operationKind: capability.operationKind,
    riskTags: [...capability.riskTags],
    executors: availableExecutors(capability),
    defaultExecutor: capability.defaultExecutor,
  };
}

function queryBinding(input: CapabilitySearchInput): string {
  return digestCanonicalJson({
    query: input.query,
    ...(input.product === undefined ? {} : { product: input.product }),
    ...(input.operationKind === undefined
      ? {}
      : { operationKind: input.operationKind }),
    ...(input.riskTags === undefined
      ? {}
      : { riskTags: [...input.riskTags].sort() }),
    limit: input.limit ?? 20,
  });
}

function parseCursor(cursor: string, expectedDigest: string): CatalogCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TypeError("cursor is not an object");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\n") !==
        ["offset", "queryDigest"].join("\n") ||
      !Number.isSafeInteger(record.offset) ||
      (record.offset as number) < 0 ||
      typeof record.queryDigest !== "string" ||
      record.queryDigest !== expectedDigest
    ) {
      throw new TypeError("cursor binding is invalid");
    }
    return {
      offset: record.offset as number,
      queryDigest: record.queryDigest,
    };
  } catch {
    throw new RouterError(
      "SCHEMA_MISMATCH",
      "Capability search cursor is invalid or belongs to another query",
    );
  }
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export class StaticCapabilityCatalog implements CapabilityCatalog {
  readonly registrations: readonly RouterCapabilityRegistration[];
  readonly #contracts: ContractRegistry;
  readonly #byId: ReadonlyMap<string, RouterCapabilityRegistration>;

  private constructor(
    registrations: readonly RouterCapabilityRegistration[],
    contracts: ContractRegistry,
  ) {
    this.registrations = registrations;
    this.#contracts = contracts;
    this.#byId = new Map(
      registrations.map((registration) => [
        registration.definition.capabilityId,
        registration,
      ]),
    );
  }

  static async create(
    registrations: readonly RouterCapabilityRegistration[],
    contractDirectory?: URL,
  ): Promise<StaticCapabilityCatalog> {
    const contracts = await ContractRegistry.load(contractDirectory);
    const seen = new Set<string>();
    for (const registration of registrations) {
      const id = registration.definition.capabilityId;
      if (
        seen.has(id) ||
        !contracts.validate(
          "capability-v1-lite.schema.json",
          registration.definition,
        ).valid
      ) {
        throw new RouterError(
          "SCHEMA_MISMATCH",
          `Static capability ${id} is duplicated or invalid`,
        );
      }
      seen.add(id);
    }
    return new StaticCapabilityCatalog([...registrations], contracts);
  }

  search(input: CapabilitySearchInput): CapabilitySearchOutput {
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", input).valid
    ) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Capability search input does not match the frozen Router contract",
      );
    }
    const normalizedQuery = input.query.trim().toLocaleLowerCase("en-US");
    if (normalizedQuery.length === 0) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Capability search query cannot contain only whitespace",
      );
    }
    const tokens = normalizedQuery === "*"
      ? []
      : normalizedQuery.split(/\s+/u).filter((token) => token.length > 0);
    const matches = this.registrations
      .map((registration) => registration.definition)
      .filter((capability) => {
        const searchable = [
          capability.capabilityId,
          capability.product,
          capability.summary,
        ]
          .join(" ")
          .toLocaleLowerCase("en-US");
        return (
          tokens.every((token) => searchable.includes(token)) &&
          (input.product === undefined || capability.product === input.product) &&
          (input.operationKind === undefined ||
            capability.operationKind === input.operationKind) &&
          (input.riskTags === undefined ||
            input.riskTags.every((tag) => capability.riskTags.includes(tag)))
        );
      })
      .sort((left, right) =>
        left.capabilityId.localeCompare(right.capabilityId, "en-US"),
      );

    const queryDigest = queryBinding(input);
    const offset = input.cursor === undefined
      ? 0
      : parseCursor(input.cursor, queryDigest).offset;
    if (offset > matches.length) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Capability search cursor offset is outside the result set",
      );
    }
    const limit = input.limit ?? 20;
    const capabilities = matches.slice(offset, offset + limit).map(searchItem);
    const nextOffset = offset + capabilities.length;
    const output: CapabilitySearchOutput = {
      schemaVersion: "huaweicloud-agent-search-output/v1-lite",
      capabilities,
      ...(nextOffset < matches.length
        ? {
            nextCursor: encodeCursor({ offset: nextOffset, queryDigest }),
          }
        : {}),
    };
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", output).valid
    ) {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Capability search output does not match the frozen Router contract",
      );
    }
    return output;
  }

  describe(input: CapabilityDescribeInput): CapabilityDescribeOutput {
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", input).valid
    ) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Capability describe input does not match the frozen Router contract",
      );
    }
    const registration = this.#byId.get(input.capabilityId);
    if (registration === undefined) {
      throw new RouterError(
        "CAPABILITY_NOT_FOUND",
        `Capability ${input.capabilityId} is not registered`,
      );
    }
    const output: CapabilityDescribeOutput = {
      schemaVersion: "huaweicloud-agent-describe-output/v1-lite",
      capability: structuredClone(registration.definition),
    };
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", output).valid
    ) {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Capability describe output does not match the frozen Router contract",
      );
    }
    return output;
  }
}
