import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";

import { createExpectedApprovalBinding } from "../approval/binding.js";
import type { ApprovalReviewer } from "../approval/types.js";
import { developmentCapabilityRegistrations } from "../catalog/development.js";
import { RouterCore } from "../router/core.js";
import { RouterError } from "../router/errors.js";
import type {
  RouterCapabilityRegistration,
  RouterDispatchRequest,
  RouterExecutorAdapter,
} from "../router/types.js";
import { LocalObsSessionManager } from "../providers/obs/session.js";
import type {
  HostCommandResult,
  HostCommandRunner,
} from "../hosts/command-runner.js";
import {
  KooCliExecutorAdapter,
  type KooCliInvocationRequest,
  type KooCliSecureInvoker,
} from "../koocli/adapter.js";

export interface StateMachineVector {
  readonly id: string;
  readonly steps: readonly Record<string, unknown>[];
}

export interface StateMachineVectorResult {
  readonly id: string;
  readonly passed: boolean;
  readonly expected: readonly string[];
  readonly observed: readonly string[];
}

const generationOne = "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4";
const generationTwo = "7cecf2cb-2a11-40ef-899a-7290e6ad66c5";

const vectorDefinitions: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  "approval-replay": [
    { event: "preview-created", expectedState: "pending" },
    { event: "valid-receipt-verified", expectedState: "pending" },
    { event: "dispatch-requested", expectedState: "consumed" },
    { event: "same-preview-dispatch-requested", expectedError: "APPROVAL_REPLAYED" },
  ],
  "outcome-unknown-does-not-unlock-executor": [
    { event: "preview-created", executor: "provider-mcp", expectedState: "pending" },
    { event: "dispatch-requested", executor: "provider-mcp", expectedState: "consumed" },
    { event: "provider-timeout", expectedError: "OUTCOME_UNKNOWN" },
    { event: "automatic-koocli-fallback", expectedError: "EXECUTOR_LOCKED" },
  ],
  "credential-generation-changed": [
    { event: "session-created", credentialGeneration: generationOne },
    { event: "credentials-file-replaced", credentialGeneration: generationTwo },
    { event: "old-session-reuse-requested", expectedError: "AUTH_SESSION_EXPIRED" },
    { event: "known-old-session-revoke", expectedResult: "best-effort" },
  ],
  "provider-unavailable-selects-koocli-before-dispatch": [
    { event: "provider-health-checked", expectedResult: "unavailable" },
    { event: "secure-koocli-boundary-checked", expectedResult: "available" },
    { event: "dispatch-requested", expectedExecutor: "koocli" },
    { event: "dispatch-completed", expectedState: "completed" },
  ],
};

function noCloudHarnessReviewer(): ApprovalReviewer {
  return {
    async review(context) {
      if (
        context.request.summary.capabilityId !==
          "huaweicloud.reference.change.simulate.v1" ||
        context.request.summary.executor !== "provider-mcp" ||
        context.accountIdentity.accountId !== "state-machine-no-cloud" ||
        context.credentialGeneration !== generationOne
      ) {
        throw new Error("State-machine doctor refused a non-reference approval");
      }
      const sessionId =
        "doctor_session_unsigned_no_cloud_000000000000000000000000000001";
      const expected = createExpectedApprovalBinding(context, sessionId);
      const approvedAt = new Date();
      const requestExpiresAt = Date.parse(context.request.expiresAt);
      const expiresAt = new Date(
        Math.min(approvedAt.getTime() + 60_000, requestExpiresAt),
      );
      return {
        schemaVersion: "huaweicloud-agent-approval-receipt/v1",
        issuerId: expected.issuerId,
        approvalSessionId: expected.approvalSessionId,
        previewId: expected.previewId,
        challengeDigest: expected.challengeDigest,
        parameterDigest: expected.parameterDigest,
        executor: expected.executor,
        credentialGeneration: expected.credentialGeneration,
        accountIdentityDigest: expected.accountIdentityDigest,
        scopeDigest: expected.scopeDigest,
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        signatureAlgorithm: "ed25519",
        // Deliberately not a valid Ed25519 signature. A production verifier
        // cannot accept this receipt; it exists only inside the no-cloud Router.
        signature:
          "doctor_only_unsigned_state_machine_receipt_000000000000000001",
      };
    },
  };
}

function dangerousCapability(): RouterCapabilityRegistration {
  const reference = developmentCapabilityRegistrations.find(
    (registration) =>
      registration.definition.capabilityId ===
      "huaweicloud.reference.change.simulate.v1",
  );
  if (reference === undefined) {
    throw new Error("Development state-machine capability is missing");
  }
  return {
    ...reference,
    definition: {
      ...reference.definition,
      executors: {
        ...reference.definition.executors,
        koocli: { service: "ECS", operation: "CreateServers" },
      },
    },
  };
}

function adapter(
  executor: "provider-mcp" | "koocli",
  execute: (request: RouterDispatchRequest) => Promise<{
    result: unknown;
    effectiveAccountId: string;
  }>,
): RouterExecutorAdapter {
  return {
    executor,
    isAvailable: async () => true,
    execute,
  };
}

function code(error: unknown): string {
  return error instanceof RouterError ? error.code : "UNKNOWN";
}

async function routerFor(
  contractDirectory: URL,
  provider: RouterExecutorAdapter,
  koocli: RouterExecutorAdapter,
): Promise<RouterCore> {
  return await RouterCore.create({
    capabilities: [dangerousCapability()],
    adapters: [provider, koocli],
    approvalReviewer: noCloudHarnessReviewer(),
    identityProvider: async () => ({
      credentialGeneration: generationOne,
      accountIdentity: { accountId: "state-machine-no-cloud" },
    }),
    contractDirectory,
  });
}

const input = {
  schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
  capabilityId: "huaweicloud.reference.change.simulate.v1",
  arguments: { name: "contract-doctor" },
  scope: {},
};

async function approvalReplay(contractDirectory: URL): Promise<string[]> {
  const provider = adapter("provider-mcp", async (request) => ({
    result: {
      mode: "development-reference",
      simulated: true,
      name: request.arguments.name,
      internalTrace: "doctor-only",
    },
    effectiveAccountId: request.identity.accountIdentity.accountId,
  }));
  const router = await routerFor(
    contractDirectory,
    provider,
    adapter("koocli", async () => ({ result: {}, effectiveAccountId: "unexpected" })),
  );
  const preview = await router.execute(input);
  if (preview.status !== "confirmation_required") return ["preview-invalid"];
  const output = await router.execute({ ...input, previewId: preview.previewId });
  let replay = "none";
  try {
    await router.execute({ ...input, previewId: preview.previewId });
  } catch (error) {
    replay = code(error);
  }
  return [preview.status, output.status, replay];
}

async function outcomeUnknown(contractDirectory: URL): Promise<string[]> {
  let koocliDispatches = 0;
  const provider = adapter("provider-mcp", async () => {
    throw new RouterError("OUTCOME_UNKNOWN", "No-cloud provider timeout fixture");
  });
  const koocli = adapter("koocli", async () => {
    koocliDispatches += 1;
    return { result: {}, effectiveAccountId: "unexpected" };
  });
  const router = await routerFor(contractDirectory, provider, koocli);
  const preview = await router.execute(input);
  if (preview.status !== "confirmation_required") return ["preview-invalid"];
  const approved = { ...input, previewId: preview.previewId };
  let providerError = "none";
  let fallbackError = "none";
  try {
    await router.execute(approved);
  } catch (error) {
    providerError = code(error);
  }
  try {
    await router.execute({ ...approved, executorPreference: "koocli" });
  } catch (error) {
    fallbackError = code(error);
  }
  return [preview.summary.executor, providerError, fallbackError, String(koocliDispatches)];
}

async function credentialGenerationChanged(): Promise<string[]> {
  const sessions = new LocalObsSessionManager({
    providerInstanceId: "contract-doctor-obs",
    client: {
      listBuckets: async () => ({ ownerAccountId: "account-1", buckets: [] }),
    },
  });
  const binding = await sessions.create({
    accessKey: "doctor-access-key",
    secretKey: "doctor-secret-key",
    generation: generationOne,
  });
  await sessions.revokeGeneration(generationOne);
  let reuseError = "none";
  try {
    await sessions.listBuckets(binding);
  } catch (error) {
    reuseError = code(error);
  }
  await sessions.revokeGeneration(generationOne);
  return [binding.credentialGeneration, generationTwo, reuseError, "best-effort"];
}

async function providerUnavailableSelectsKooCli(
  contractDirectory: URL,
): Promise<string[]> {
  const reference = developmentCapabilityRegistrations.find(
    (registration) =>
      registration.definition.capabilityId ===
      "huaweicloud.reference.catalog.inspect.v1",
  );
  if (reference === undefined) return ["CAPABILITY_MISSING"];
  const capability: RouterCapabilityRegistration = {
    ...reference,
    definition: {
      ...reference.definition,
      executors: {
        ...reference.definition.executors,
        koocli: { service: "ECS", operation: "ListServersDetails" },
      },
    },
  };
  let providerChecks = 0;
  const provider: RouterExecutorAdapter = {
    executor: "provider-mcp",
    isAvailable: async () => {
      providerChecks += 1;
      return false;
    },
    execute: async () => {
      throw new Error("Unavailable provider was dispatched");
    },
  };
  const executablePath = resolve("doctor-fixture", "hcloud");
  const runner: HostCommandRunner = {
    resolveCommand: async (command) => command === "hcloud"
      ? executablePath
      : undefined,
    run: async (
      path: string,
      args: readonly string[],
    ): Promise<HostCommandResult> => ({
      code: path === executablePath && args.join(" ") === "version" ? 0 : 2,
      signal: null,
      stdout: "KooCLI 7.2.12\n",
      stderr: "",
    }),
  };
  let boundaryChecks = 0;
  let dispatches = 0;
  const invoker: KooCliSecureInvoker = {
    isAvailable: async () => {
      boundaryChecks += 1;
      return true;
    },
    invoke: async (_request: KooCliInvocationRequest) => {
      dispatches += 1;
      return {
        result: {
          mode: "development-reference",
          items: ["koocli-no-cloud-fixture"],
          notice: "No cloud operation was performed",
        },
        effectiveAccountId: "state-machine-no-cloud",
      };
    },
  };
  const koocli = new KooCliExecutorAdapter({
    runtimeRoot: resolve("doctor-fixture", "runtime"),
    artifacts: [],
    runner,
    invoker,
  });
  const router = await RouterCore.create({
    capabilities: [capability],
    adapters: [provider, koocli],
    approvalReviewer: noCloudHarnessReviewer(),
    identityProvider: async () => ({
      credentialGeneration: generationOne,
      accountIdentity: { accountId: "state-machine-no-cloud" },
    }),
    contractDirectory,
  });
  const output = await router.execute({
    schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
    capabilityId: capability.definition.capabilityId,
    arguments: { query: "no-cloud" },
    scope: {},
  });
  return [
    String(providerChecks),
    String(boundaryChecks),
    output.status === "completed" ? output.execution.executor : output.status,
    output.status,
    String(dispatches),
  ];
}

function expectedObservation(id: string): readonly string[] {
  switch (id) {
    case "approval-replay":
      return ["confirmation_required", "completed", "APPROVAL_REPLAYED"];
    case "outcome-unknown-does-not-unlock-executor":
      return ["provider-mcp", "OUTCOME_UNKNOWN", "EXECUTOR_LOCKED", "0"];
    case "credential-generation-changed":
      return [generationOne, generationTwo, "AUTH_SESSION_EXPIRED", "best-effort"];
    case "provider-unavailable-selects-koocli-before-dispatch":
      return ["1", "2", "koocli", "completed", "1"];
    default:
      return [];
  }
}

export async function runStateMachineDoctor(
  vectors: readonly StateMachineVector[],
  contractDirectory: URL,
): Promise<readonly StateMachineVectorResult[]> {
  const results: StateMachineVectorResult[] = [];
  for (const vector of vectors) {
    const definition = vectorDefinitions[vector.id];
    const expected = expectedObservation(vector.id);
    if (definition === undefined || !isDeepStrictEqual(vector.steps, definition)) {
      results.push({
        id: vector.id,
        passed: false,
        expected,
        observed: ["VECTOR_SHAPE_MISMATCH"],
      });
      continue;
    }
    let observed: readonly string[];
    switch (vector.id) {
      case "approval-replay":
        observed = await approvalReplay(contractDirectory);
        break;
      case "outcome-unknown-does-not-unlock-executor":
        observed = await outcomeUnknown(contractDirectory);
        break;
      case "credential-generation-changed":
        observed = await credentialGenerationChanged();
        break;
      case "provider-unavailable-selects-koocli-before-dispatch":
        observed = await providerUnavailableSelectsKooCli(contractDirectory);
        break;
      default:
        observed = ["UNSUPPORTED_VECTOR"];
    }
    results.push({
      id: vector.id,
      passed: isDeepStrictEqual(observed, expected),
      expected,
      observed,
    });
  }
  return results;
}
