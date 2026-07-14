import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

import { createExpectedApprovalBinding } from "../approval/binding.js";
import {
  digestAccountIdentity,
} from "../approval/canonical.js";
import {
  approvalIssuerId,
  maxApprovalClockSkewMs,
  maxApprovalReceiptTtlMs,
} from "../approval/constants.js";
import { ApprovalCompanionLauncher } from "../approval/launcher.js";
import type {
  ApprovalExecutor,
  ApprovalReceipt,
  ApprovalRequest,
  ApprovalReviewer,
  ApprovalSigningContext,
  ApprovalScope,
  ExpectedApprovalBinding,
} from "../approval/types.js";
import { ContractRegistry } from "../contracts/registry.js";
import { canonicalizeJson, digestCanonicalJson } from "./canonical.js";
import { RouterError } from "./errors.js";
import { redactJsonPointers } from "./redaction.js";
import type {
  CompiledRouterCapability,
  RouterCapabilityDefinition,
  RouterCoreOptions,
  RouterDispatchResult,
  RouterExecuteInput,
  RouterExecuteOutput,
  RouterExecuteResponse,
  RouterExecutorAdapter,
  RouterIdentityContext,
} from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

interface PendingPreview {
  state: "pending" | "consumed";
  readonly capability: CompiledRouterCapability;
  readonly adapter: RouterExecutorAdapter;
  readonly context: ApprovalSigningContext;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly scope: ApprovalScope;
  readonly inputDigest: string;
  approvedReceipt?: ApprovalReceipt;
  reviewPromise?: Promise<ApprovalReceipt | null>;
}

const expectedReceiptFields = [
  "issuerId",
  "approvalSessionId",
  "previewId",
  "challengeDigest",
  "parameterDigest",
  "executor",
  "credentialGeneration",
  "accountIdentityDigest",
  "scopeDigest",
] as const;

function supportsExecutor(
  capability: RouterCapabilityDefinition,
  executor: ApprovalExecutor,
): boolean {
  return executor === "provider-mcp"
    ? capability.executors.providerMcp !== undefined
    : capability.executors.koocli !== undefined;
}

function requiresApproval(capability: RouterCapabilityDefinition): boolean {
  return !(
    capability.operationKind === "read" &&
    capability.riskTags.length === 0 &&
    capability.confirmationRequired === false
  );
}

function opaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function assertScope(
  capability: RouterCapabilityDefinition,
  scope: ApprovalScope,
): void {
  for (const field of ["region", "project"] as const) {
    const rule = capability.scope[field];
    const value = scope[field];
    if (rule === "required" && value === undefined) {
      throw new RouterError(
        "INVALID_SCOPE",
        `Capability ${capability.capabilityId} requires scope.${field}`,
      );
    }
    if (rule === "forbidden" && value !== undefined) {
      throw new RouterError(
        "INVALID_SCOPE",
        `Capability ${capability.capabilityId} forbids scope.${field}`,
      );
    }
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const leftBytes = Buffer.from(canonicalizeJson(left), "utf8");
  const rightBytes = Buffer.from(canonicalizeJson(right), "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function assertExpectedReceiptFields(
  receipt: ApprovalReceipt,
  expected: ExpectedApprovalBinding,
): void {
  for (const field of expectedReceiptFields) {
    if (receipt[field] !== expected[field]) {
      throw new RouterError(
        "APPROVAL_INVALID",
        `Approval receipt ${field} does not match the pending preview`,
      );
    }
  }
}

export class RouterCore {
  readonly #capabilities: ReadonlyMap<string, CompiledRouterCapability>;
  readonly #adapters: ReadonlyMap<ApprovalExecutor, RouterExecutorAdapter>;
  readonly #contracts: ContractRegistry;
  readonly #options: RouterCoreOptions;
  readonly #approvalReviewer: ApprovalReviewer;
  readonly #previewTtlMs: number;
  readonly #previews = new Map<string, PendingPreview>();

  private constructor(
    options: RouterCoreOptions,
    contracts: ContractRegistry,
    capabilities: ReadonlyMap<string, CompiledRouterCapability>,
    adapters: ReadonlyMap<ApprovalExecutor, RouterExecutorAdapter>,
    approvalReviewer: ApprovalReviewer,
    previewTtlMs: number,
  ) {
    this.#options = options;
    this.#contracts = contracts;
    this.#capabilities = capabilities;
    this.#adapters = adapters;
    this.#approvalReviewer = approvalReviewer;
    this.#previewTtlMs = previewTtlMs;
  }

  static async create(options: RouterCoreOptions): Promise<RouterCore> {
    const previewTtlMs = options.previewTtlMs ?? 300_000;
    if (
      !Number.isInteger(previewTtlMs) ||
      previewTtlMs < 1_000 ||
      previewTtlMs > 300_000
    ) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Router preview TTL must be between 1 and 300 seconds",
      );
    }

    const contracts = await ContractRegistry.load(options.contractDirectory);
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: true,
    });
    addFormats(ajv);

    const capabilities = new Map<string, CompiledRouterCapability>();
    for (const registration of options.capabilities) {
      const definition = registration.definition;
      if (
        !contracts.validate("capability-v1-lite.schema.json", definition).valid
      ) {
        throw new RouterError(
          "SCHEMA_MISMATCH",
          `Capability ${definition.capabilityId} does not match the frozen contract`,
        );
      }
      if (capabilities.has(definition.capabilityId)) {
        throw new RouterError(
          "SCHEMA_MISMATCH",
          `Capability ${definition.capabilityId} is registered more than once`,
        );
      }
      capabilities.set(definition.capabilityId, {
        registration,
        validateInput: ajv.compile(definition.inputSchema),
        validateOutput: ajv.compile(definition.outputSchema),
      });
    }

    const adapters = new Map<ApprovalExecutor, RouterExecutorAdapter>();
    for (const adapter of options.adapters) {
      if (adapters.has(adapter.executor)) {
        throw new RouterError(
          "SCHEMA_MISMATCH",
          `Executor ${adapter.executor} is registered more than once`,
        );
      }
      adapters.set(adapter.executor, adapter);
    }

    const approvalReviewer =
      options.approvalReviewer ??
      (await ApprovalCompanionLauncher.fromRuntimeManifest(
        options.approvalManifestUrl,
        options.contractDirectory,
      ));

    return new RouterCore(
      options,
      contracts,
      capabilities,
      adapters,
      approvalReviewer,
      previewTtlMs,
    );
  }

  async execute(input: RouterExecuteInput): Promise<RouterExecuteResponse> {
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", input).valid
    ) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        "Execute input does not match the frozen Router contract",
      );
    }

    const capability = this.#capabilities.get(input.capabilityId);
    if (capability === undefined) {
      throw new RouterError(
        "CAPABILITY_NOT_FOUND",
        `Capability ${input.capabilityId} is not registered`,
      );
    }
    if (!capability.validateInput(input.arguments)) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        `Arguments for ${input.capabilityId} do not match its input schema`,
      );
    }
    assertScope(capability.registration.definition, input.scope);

    if (input.previewId !== undefined) {
      if (input.approvalReceipt === undefined) {
        throw new RouterError(
          "APPROVAL_INVALID",
          "A preview ID and approval receipt must be supplied together",
        );
      }
      return this.#executeApproved(
        {
          ...input,
          previewId: input.previewId,
          approvalReceipt: input.approvalReceipt,
        },
        capability,
      );
    }

    const identity = await this.#options.identityProvider();
    const adapter = await this.#selectAdapter(
      capability.registration.definition,
      input.executorPreference,
    );
    if (!requiresApproval(capability.registration.definition)) {
      return this.#dispatch(
        capability,
        adapter,
        structuredClone(input.arguments),
        structuredClone(input.scope),
        identity,
      );
    }
    return this.#createPreview(input, capability, adapter, identity);
  }

  /**
   * Trusted Router/host path. This method is never registered as an MCP tool.
   */
  async reviewPendingPreview(
    previewId: string,
  ): Promise<ApprovalReceipt | null> {
    const pending = this.#previews.get(previewId);
    if (pending === undefined) {
      throw new RouterError(
        "APPROVAL_INVALID",
        "The approval preview does not exist in this Router process",
      );
    }
    if (pending.state === "consumed") {
      throw new RouterError(
        "APPROVAL_REPLAYED",
        "The approval preview has already been consumed",
      );
    }
    this.#assertPreviewFresh(pending);
    if (pending.approvedReceipt !== undefined) {
      this.#assertReceiptFresh(pending.approvedReceipt);
      return structuredClone(pending.approvedReceipt);
    }
    if (pending.reviewPromise !== undefined) {
      return pending.reviewPromise;
    }

    const reviewPromise = this.#performReview(pending);
    pending.reviewPromise = reviewPromise;
    try {
      return await reviewPromise;
    } finally {
      if (pending.reviewPromise === reviewPromise) {
        delete pending.reviewPromise;
      }
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  async #performReview(
    pending: PendingPreview,
  ): Promise<ApprovalReceipt | null> {
    const receipt = await this.#approvalReviewer.review(pending.context);
    if (receipt === null) {
      return null;
    }
    if (pending.state !== "pending") {
      throw new RouterError(
        "APPROVAL_REPLAYED",
        "The approval preview was consumed while approval was pending",
      );
    }
    this.#assertPreviewFresh(pending);
    if (!this.#contracts.validate("approval-v1.schema.json", receipt).valid) {
      throw new RouterError(
        "APPROVAL_INVALID",
        "Approval reviewer returned a receipt outside the frozen contract",
      );
    }
    assertExpectedReceiptFields(
      receipt,
      createExpectedApprovalBinding(
        pending.context,
        receipt.approvalSessionId,
      ),
    );
    this.#assertReceiptFresh(receipt);
    pending.approvedReceipt = structuredClone(receipt);
    return structuredClone(receipt);
  }

  async #executeApproved(
    input: RouterExecuteInput & {
      readonly previewId: string;
      readonly approvalReceipt: ApprovalReceipt;
    },
    capability: CompiledRouterCapability,
  ): Promise<RouterExecuteOutput> {
    const pending = this.#previews.get(input.previewId);
    if (pending === undefined) {
      throw new RouterError(
        "APPROVAL_INVALID",
        "The approval preview does not exist in this Router process",
      );
    }
    if (pending.state === "consumed") {
      throw new RouterError(
        "APPROVAL_REPLAYED",
        "The approval preview has already been consumed",
      );
    }
    this.#assertPreviewFresh(pending);

    if (
      pending.capability !== capability ||
      pending.inputDigest !== this.#inputDigest(input) ||
      !sameCanonicalValue(pending.scope, input.scope)
    ) {
      throw new RouterError(
        "APPROVAL_INVALID",
        "Capability, arguments, or scope changed after preview creation",
      );
    }
    if (
      input.executorPreference !== undefined &&
      input.executorPreference !== pending.adapter.executor
    ) {
      throw new RouterError(
        "EXECUTOR_LOCKED",
        "Executor cannot change after preview creation",
      );
    }

    const identity = await this.#options.identityProvider();
    if (
      identity.credentialGeneration !== pending.context.credentialGeneration
    ) {
      throw new RouterError(
        "AUTH_SESSION_EXPIRED",
        "Credential generation changed after preview creation",
      );
    }
    if (
      digestAccountIdentity(identity.accountIdentity) !==
      digestAccountIdentity(pending.context.accountIdentity)
    ) {
      throw new RouterError(
        "ACCOUNT_MISMATCH",
        "Account identity changed after preview creation",
      );
    }
    if (pending.state !== "pending") {
      throw new RouterError(
        "APPROVAL_REPLAYED",
        "The approval preview has already been consumed",
      );
    }
    if (
      pending.approvedReceipt === undefined ||
      !sameCanonicalValue(pending.approvedReceipt, input.approvalReceipt)
    ) {
      throw new RouterError(
        "APPROVAL_INVALID",
        "Receipt was not issued for this pending preview",
      );
    }
    this.#assertReceiptFresh(input.approvalReceipt);

    // Synchronous transition before the first dispatch await makes consumption
    // atomic inside this Router process. Errors never restore pending state.
    pending.state = "consumed";
    return this.#dispatch(
      pending.capability,
      pending.adapter,
      pending.arguments,
      pending.scope,
      identity,
    );
  }

  #createPreview(
    input: RouterExecuteInput,
    capability: CompiledRouterCapability,
    adapter: RouterExecutorAdapter,
    identity: RouterIdentityContext,
  ): ApprovalRequest {
    const argumentsValue = structuredClone(input.arguments);
    const scope = structuredClone(input.scope);
    const previewId = opaqueId();
    const now = this.#now();
    const details = capability.registration.summarize(argumentsValue, scope);
    const request: ApprovalRequest = {
      schemaVersion: "huaweicloud-agent-approval-request/v1",
      status: "confirmation_required",
      previewId,
      challenge: opaqueId(),
      parameterDigest: this.#inputDigest({
        ...input,
        arguments: argumentsValue,
      }),
      summary: {
        capabilityId: capability.registration.definition.capabilityId,
        executor: adapter.executor,
        operationKind: capability.registration.definition.operationKind,
        riskTags: [...capability.registration.definition.riskTags],
        scope,
        resources: [...details.resources],
        effects: [...details.effects],
      },
      allowedIssuerIds: [approvalIssuerId],
      expiresAt: new Date(now.getTime() + this.#previewTtlMs).toISOString(),
    };
    if (!this.#contracts.validate("approval-v1.schema.json", request).valid) {
      throw new RouterError(
        "SCHEMA_MISMATCH",
        `Approval summary for ${input.capabilityId} does not match the frozen contract`,
      );
    }

    this.#previews.set(previewId, {
      state: "pending",
      capability,
      adapter,
      context: {
        request,
        credentialGeneration: identity.credentialGeneration,
        accountIdentity: structuredClone(identity.accountIdentity),
      },
      arguments: argumentsValue,
      scope,
      inputDigest: request.parameterDigest,
    });
    return structuredClone(request);
  }

  #inputDigest(input: Pick<RouterExecuteInput, "capabilityId" | "arguments">): string {
    return digestCanonicalJson({
      capabilityId: input.capabilityId,
      arguments: input.arguments,
    });
  }

  #assertPreviewFresh(pending: PendingPreview): void {
    const expiresAt = Date.parse(pending.context.request.expiresAt);
    if (!Number.isFinite(expiresAt) || this.#now().getTime() > expiresAt) {
      throw new RouterError(
        "APPROVAL_EXPIRED",
        "The approval preview has expired",
      );
    }
  }

  #assertReceiptFresh(receipt: ApprovalReceipt): void {
    const approvedAt = Date.parse(receipt.approvedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    const now = this.#now().getTime();
    if (
      !Number.isFinite(approvedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= approvedAt ||
      expiresAt - approvedAt > maxApprovalReceiptTtlMs ||
      now < approvedAt - maxApprovalClockSkewMs ||
      now > expiresAt + maxApprovalClockSkewMs
    ) {
      throw new RouterError(
        "APPROVAL_EXPIRED",
        "The approval receipt has expired",
      );
    }
  }

  async #selectAdapter(
    capability: RouterCapabilityDefinition,
    preference?: ApprovalExecutor,
  ): Promise<RouterExecutorAdapter> {
    const order: ApprovalExecutor[] = [];
    if (preference !== undefined) {
      order.push(preference);
    }
    for (const candidate of [
      "provider-mcp",
      capability.defaultExecutor,
      "koocli",
    ] as const) {
      if (!order.includes(candidate)) {
        order.push(candidate);
      }
    }

    for (const executor of order) {
      const adapter = this.#adapters.get(executor);
      if (
        adapter !== undefined &&
        supportsExecutor(capability, executor) &&
        (await adapter.isAvailable(capability))
      ) {
        return adapter;
      }
    }
    throw new RouterError(
      "PROVIDER_UNAVAILABLE",
      `No healthy executor is available for ${capability.capabilityId}`,
      true,
    );
  }

  async #dispatch(
    capability: CompiledRouterCapability,
    adapter: RouterExecutorAdapter,
    argumentsValue: Readonly<Record<string, unknown>>,
    scope: ApprovalScope,
    identity: RouterIdentityContext,
  ): Promise<RouterExecuteOutput> {
    const startedAt = performance.now();
    const correlationId = randomUUID();
    const dispatchResult = await adapter.execute({
      capability: capability.registration.definition,
      arguments: argumentsValue,
      scope,
      identity,
      correlationId,
    });
    const result = this.#validateDispatchResult(
      capability,
      dispatchResult,
      scope,
      identity,
    );

    const execution: RouterExecuteOutput["execution"] = {
      correlationId,
      executor: adapter.executor,
      effectiveAccountId: dispatchResult.effectiveAccountId,
      ...(dispatchResult.effectiveProjectId === undefined
        ? {}
        : { effectiveProjectId: dispatchResult.effectiveProjectId }),
      ...(dispatchResult.effectiveRegion === undefined
        ? {}
        : { effectiveRegion: dispatchResult.effectiveRegion }),
      ...(dispatchResult.requestId === undefined
        ? {}
        : { requestId: dispatchResult.requestId }),
      durationMs: Math.max(0, Math.trunc(performance.now() - startedAt)),
    };
    const output: RouterExecuteOutput = {
      schemaVersion: "huaweicloud-agent-execute-output/v1-lite",
      status: "completed",
      result,
      execution,
    };
    if (
      !this.#contracts.validate("router-tools-v1-lite.schema.json", output).valid
    ) {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Executor output does not match the frozen Router contract",
      );
    }
    return output;
  }

  #validateDispatchResult(
    capability: CompiledRouterCapability,
    result: RouterDispatchResult,
    scope: ApprovalScope,
    identity: RouterIdentityContext,
  ): unknown {
    if (result.effectiveAccountId !== identity.accountIdentity.accountId) {
      throw new RouterError(
        "ACCOUNT_MISMATCH",
        "Executor returned a different effective account",
      );
    }
    if (
      scope.project !== undefined &&
      result.effectiveProjectId !== undefined &&
      result.effectiveProjectId !== scope.project
    ) {
      throw new RouterError(
        "ACCOUNT_MISMATCH",
        "Executor returned a different effective project",
      );
    }
    if (
      scope.region !== undefined &&
      result.effectiveRegion !== undefined &&
      result.effectiveRegion !== scope.region
    ) {
      throw new RouterError(
        "INVALID_SCOPE",
        "Executor returned a different effective region",
      );
    }
    if (!capability.validateOutput(result.result)) {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Executor result does not match the capability output schema",
      );
    }
    let outputBytes: number;
    try {
      outputBytes = Buffer.byteLength(JSON.stringify(result.result), "utf8");
    } catch {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Executor result is not serializable JSON",
      );
    }
    if (
      outputBytes > capability.registration.definition.outputPolicy.maxBytes ||
      (typeof result.result === "string" &&
        !capability.registration.definition.outputPolicy.allowProviderText)
    ) {
      throw new RouterError(
        "OUTPUT_REJECTED",
        "Executor result violates the capability output policy",
      );
    }
    return redactJsonPointers(
      result.result,
      capability.registration.definition.outputPolicy.sensitivePaths,
    );
  }
}
