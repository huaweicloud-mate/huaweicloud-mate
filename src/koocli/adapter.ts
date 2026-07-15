import { isAbsolute, resolve } from "node:path";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { NodeHostCommandRunner } from "../hosts/command-runner.js";
import { RouterError, type RouterErrorCode } from "../router/errors.js";
import type {
  RouterCapabilityDefinition,
  RouterDispatchRequest,
  RouterDispatchResult,
  RouterExecutorAdapter,
} from "../router/types.js";
import type { KooCliArtifactBinding } from "./artifacts.js";
import { inspectKooCliAvailability } from "./selection.js";

const servicePattern = /^[A-Za-z0-9]{1,64}$/u;
const operationPattern = /^[A-Za-z0-9]{1,128}$/u;
const boundedIdentityPattern = /^.{1,512}$/u;
const credentialKeyPattern = /^(?:accesskey|access_key|ak|authorization|credential|password|secret|secretaccesskey|secret_access_key|securitytoken|security_token|sk|token)$/iu;
const maxInvocationInputBytes = 1024 * 1024;

export interface KooCliInvocationRequest {
  readonly executablePath: string;
  readonly version: string;
  readonly service: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly region?: string;
  readonly project?: string;
  readonly credentialGeneration: string;
  readonly expectedAccountId: string;
  readonly expectedDomainId?: string;
  readonly correlationId: string;
}

export interface KooCliInvocationResult {
  readonly result: unknown;
  readonly effectiveAccountId: string;
  readonly effectiveProjectId?: string;
  readonly effectiveRegion?: string;
  readonly requestId?: string;
}

export interface KooCliSecureInvoker {
  isAvailable(input: {
    readonly executablePath: string;
    readonly version: string;
  }): Promise<boolean>;
  invoke(request: KooCliInvocationRequest): Promise<KooCliInvocationResult>;
}

export type KooCliInvocationFailure =
  | "account-mismatch"
  | "conflict"
  | "invalid-scope"
  | "outcome-unknown"
  | "permission-denied"
  | "rate-limited"
  | "timeout"
  | "unavailable"
  | "validation-failed";

export class KooCliInvocationError extends Error {
  constructor(readonly failure: KooCliInvocationFailure) {
    super("Secure KooCLI invocation failed");
    this.name = "KooCliInvocationError";
  }
}

export interface KooCliExecutorOptions {
  readonly runtimeRoot: string;
  readonly artifacts: readonly KooCliArtifactBinding[];
  readonly invoker?: KooCliSecureInvoker;
  readonly runner?: HostCommandRunner;
}

function hasCredentialKey(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (ancestors.has(value)) {
    throw new RouterError("VALIDATION_FAILED", "KooCLI arguments contain a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((entry) => hasCredentialKey(entry, ancestors));
    }
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) =>
        credentialKeyPattern.test(key) || hasCredentialKey(entry, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

function renderedSize(value: unknown): number {
  let rendered: string | undefined;
  try {
    rendered = JSON.stringify(value);
  } catch {
    throw new RouterError("VALIDATION_FAILED", "KooCLI value is not JSON serializable");
  }
  if (rendered === undefined) {
    throw new RouterError("VALIDATION_FAILED", "KooCLI value is not JSON serializable");
  }
  return Buffer.byteLength(rendered, "utf8");
}

function mapping(capability: RouterCapabilityDefinition): {
  readonly service: string;
  readonly operation: string;
} | undefined {
  const value = capability.executors.koocli;
  if (value === undefined) return undefined;
  if (
    !servicePattern.test(value.service) ||
    !operationPattern.test(value.operation)
  ) {
    throw new RouterError(
      "SCHEMA_MISMATCH",
      "KooCLI capability mapping is invalid",
    );
  }
  return value;
}

function mapFailure(
  error: KooCliInvocationError,
  operationKind: RouterCapabilityDefinition["operationKind"],
): RouterError {
  let code: RouterErrorCode;
  let retryable = false;
  switch (error.failure) {
    case "account-mismatch": code = "ACCOUNT_MISMATCH"; break;
    case "conflict": code = "CONFLICT"; break;
    case "invalid-scope": code = "INVALID_SCOPE"; break;
    case "outcome-unknown": code = "OUTCOME_UNKNOWN"; break;
    case "permission-denied": code = "PERMISSION_DENIED"; break;
    case "rate-limited":
      code = "RATE_LIMITED";
      retryable = operationKind === "read";
      break;
    case "timeout":
      code = operationKind === "write" ? "OUTCOME_UNKNOWN" : "UPSTREAM_TIMEOUT";
      retryable = operationKind === "read";
      break;
    case "unavailable":
      code = "PROVIDER_UNAVAILABLE";
      retryable = true;
      break;
    case "validation-failed": code = "VALIDATION_FAILED"; break;
  }
  return new RouterError(code, "Secure KooCLI invocation failed", retryable);
}

function boundedIdentity(value: string | undefined, description: string): void {
  if (value !== undefined && !boundedIdentityPattern.test(value)) {
    throw new RouterError("OUTPUT_REJECTED", `KooCLI ${description} is invalid`);
  }
}

export class KooCliExecutorAdapter implements RouterExecutorAdapter {
  readonly executor = "koocli" as const;
  readonly #runtimeRoot: string;
  readonly #artifacts: readonly KooCliArtifactBinding[];
  readonly #invoker: KooCliSecureInvoker | undefined;
  readonly #runner: HostCommandRunner;

  constructor(options: KooCliExecutorOptions) {
    if (!isAbsolute(options.runtimeRoot)) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "KooCLI adapter runtime root must be absolute",
      );
    }
    this.#runtimeRoot = resolve(options.runtimeRoot);
    this.#artifacts = options.artifacts;
    this.#invoker = options.invoker;
    this.#runner = options.runner ?? new NodeHostCommandRunner();
  }

  async isAvailable(capability: RouterCapabilityDefinition): Promise<boolean> {
    if (mapping(capability) === undefined || this.#invoker === undefined) {
      return false;
    }
    const selected = await inspectKooCliAvailability(
      this.#runtimeRoot,
      this.#runner,
      this.#artifacts,
    );
    return selected.compatible && await this.#invoker.isAvailable({
      executablePath: selected.executablePath,
      version: selected.version,
    });
  }

  async execute(request: RouterDispatchRequest): Promise<RouterDispatchResult> {
    const fixed = mapping(request.capability);
    if (fixed === undefined || this.#invoker === undefined) {
      throw new RouterError(
        "PROVIDER_UNAVAILABLE",
        "Secure KooCLI invocation is unavailable",
        true,
      );
    }
    if (hasCredentialKey(request.arguments)) {
      throw new RouterError(
        "VALIDATION_FAILED",
        "Credentials are forbidden in KooCLI operation arguments",
      );
    }
    if (renderedSize(request.arguments) > maxInvocationInputBytes) {
      throw new RouterError(
        "VALIDATION_FAILED",
        "KooCLI operation arguments exceed the size limit",
      );
    }
    const selected = await inspectKooCliAvailability(
      this.#runtimeRoot,
      this.#runner,
      this.#artifacts,
    );
    if (
      !selected.compatible ||
      !await this.#invoker.isAvailable({
        executablePath: selected.executablePath,
        version: selected.version,
      })
    ) {
      throw new RouterError(
        "PROVIDER_UNAVAILABLE",
        "Compatible KooCLI or its secure invocation boundary is unavailable",
        true,
      );
    }
    let result: KooCliInvocationResult;
    try {
      result = await this.#invoker.invoke({
        executablePath: selected.executablePath,
        version: selected.version,
        service: fixed.service,
        operation: fixed.operation,
        arguments: structuredClone(request.arguments),
        ...(request.scope.region === undefined
          ? {}
          : { region: request.scope.region }),
        ...(request.scope.project === undefined
          ? {}
          : { project: request.scope.project }),
        credentialGeneration: request.identity.credentialGeneration,
        expectedAccountId: request.identity.accountIdentity.accountId,
        ...(request.identity.accountIdentity.domainId === undefined
          ? {}
          : { expectedDomainId: request.identity.accountIdentity.domainId }),
        correlationId: request.correlationId,
      });
    } catch (error) {
      if (error instanceof KooCliInvocationError) {
        throw mapFailure(error, request.capability.operationKind);
      }
      throw new RouterError("UNKNOWN", "Secure KooCLI invocation failed");
    }
    boundedIdentity(result.effectiveAccountId, "account identity");
    boundedIdentity(result.effectiveProjectId, "project identity");
    boundedIdentity(result.effectiveRegion, "region identity");
    boundedIdentity(result.requestId, "request ID");
    if (result.effectiveAccountId !== request.identity.accountIdentity.accountId) {
      throw new RouterError("ACCOUNT_MISMATCH", "KooCLI returned a different account");
    }
    if (
      request.scope.project !== undefined &&
      result.effectiveProjectId !== request.scope.project
    ) {
      throw new RouterError("INVALID_SCOPE", "KooCLI returned a different project");
    }
    if (
      request.scope.region !== undefined &&
      result.effectiveRegion !== request.scope.region
    ) {
      throw new RouterError("INVALID_SCOPE", "KooCLI returned a different region");
    }
    if (renderedSize(result.result) > request.capability.outputPolicy.maxBytes) {
      throw new RouterError("OUTPUT_REJECTED", "KooCLI result exceeds the capability limit");
    }
    return structuredClone(result);
  }
}
