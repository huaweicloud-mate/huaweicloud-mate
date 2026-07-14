import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import { ApprovalError } from "../../src/approval/errors.js";
import type { ApprovalReviewer } from "../../src/approval/types.js";
import { RouterCore } from "../../src/router/core.js";
import { RouterError } from "../../src/router/errors.js";
import type {
  RouterCapabilityRegistration,
  RouterDispatchRequest,
  RouterExecuteInput,
  RouterExecutorAdapter,
  RouterIdentityContext,
} from "../../src/router/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve(
  "test/fixtures/approval-companion-child.mjs",
);

const safeRead: RouterCapabilityRegistration = {
  definition: {
    schemaVersion: "huaweicloud-agent-capability/v1-lite",
    capabilityId: "huaweicloud.obs.bucket.list.v1",
    product: "obs",
    summary: "List OBS buckets",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["buckets"],
      properties: {
        buckets: { type: "array", items: { type: "string" } },
      },
    },
    scope: { region: "optional", project: "forbidden" },
    operationKind: "read",
    riskTags: [],
    confirmationRequired: false,
    executors: {
      providerMcp: {
        providerId: "huaweicloud-reference-test",
        tool: "reference_list_buckets",
        inputSchemaDigest: `sha256:${"a".repeat(64)}`,
      },
    },
    defaultExecutor: "provider-mcp",
    outputPolicy: {
      sensitivePaths: [],
      maxBytes: 65_536,
      allowProviderText: false,
    },
  },
  summarize: () => ({
    resources: ["OBS buckets"],
    effects: ["Read bucket metadata"],
  }),
};

const dangerousWrite: RouterCapabilityRegistration = {
  definition: {
    schemaVersion: "huaweicloud-agent-capability/v1-lite",
    capabilityId: "huaweicloud.ecs.server.create.v1",
    product: "ecs",
    summary: "Create a test ECS server",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["serverId"],
      properties: { serverId: { type: "string" } },
    },
    scope: { region: "required", project: "optional" },
    operationKind: "write",
    riskTags: ["cost", "privileged"],
    confirmationRequired: true,
    executors: {
      providerMcp: {
        providerId: "huaweicloud-reference-test",
        tool: "reference_create_server",
        inputSchemaDigest: `sha256:${"b".repeat(64)}`,
      },
      koocli: { service: "ECS", operation: "CreateServers" },
    },
    defaultExecutor: "provider-mcp",
    outputPolicy: {
      sensitivePaths: [],
      maxBytes: 65_536,
      allowProviderText: false,
    },
  },
  summarize: (argumentsValue) => ({
    resources: [`ecs/server/${String(argumentsValue.name)}`],
    effects: ["Create one billable test server", "Allow configured network access"],
  }),
};

const baseIdentity: RouterIdentityContext = {
  credentialGeneration: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
  accountIdentity: { accountId: "account-1", domainId: "domain-1" },
};

const dangerousInput: RouterExecuteInput = {
  schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
  capabilityId: dangerousWrite.definition.capabilityId,
  arguments: { name: "test-server" },
  scope: { region: "cn-north-4", project: "project-1" },
};

async function trustedReviewer(): Promise<ApprovalCompanionLauncher> {
  return new ApprovalCompanionLauncher({
    entryPath: companionFixturePath,
    expectedSha256: await sha256File(companionFixturePath),
    contractDirectory,
    timeoutMs: 10_000,
  });
}

function adapter(
  executor: "provider-mcp" | "koocli",
  execute: (request: RouterDispatchRequest) => Promise<{
    result: unknown;
    effectiveAccountId: string;
    effectiveProjectId?: string;
    effectiveRegion?: string;
    requestId?: string;
  }>,
): RouterExecutorAdapter {
  return {
    executor,
    isAvailable: async () => true,
    execute,
  };
}

function successfulAdapter(
  executor: "provider-mcp" | "koocli" = "provider-mcp",
): RouterExecutorAdapter {
  return adapter(executor, async (request) => ({
    result:
      request.capability.capabilityId === safeRead.definition.capabilityId
        ? { buckets: ["test-bucket"] }
        : { serverId: "server-1" },
    effectiveAccountId: request.identity.accountIdentity.accountId,
    ...(request.scope.project === undefined
      ? {}
      : { effectiveProjectId: request.scope.project }),
    ...(request.scope.region === undefined
      ? {}
      : { effectiveRegion: request.scope.region }),
    requestId: "request-1",
  }));
}

async function createRouter(options: {
  reviewer?: ApprovalReviewer;
  provider?: RouterExecutorAdapter;
  koocli?: RouterExecutorAdapter;
  identityProvider?: () => Promise<RouterIdentityContext>;
  capabilities?: readonly RouterCapabilityRegistration[];
} = {}): Promise<RouterCore> {
  return RouterCore.create({
    capabilities: options.capabilities ?? [safeRead, dangerousWrite],
    adapters: [
      options.provider ?? successfulAdapter(),
      options.koocli ?? successfulAdapter("koocli"),
    ],
    approvalReviewer: options.reviewer ?? (await trustedReviewer()),
    identityProvider:
      options.identityProvider ?? (async () => structuredClone(baseIdentity)),
    contractDirectory,
  });
}

async function createPreview(router: RouterCore) {
  const preview = await router.execute(dangerousInput);
  if (preview.status !== "confirmation_required") {
    throw new Error("Expected a confirmation preview");
  }
  return preview;
}

describe("minimal Router approval state machine", () => {
  it("executes an ordinary read without opening approval", async () => {
    let reviewCount = 0;
    const router = await createRouter({
      reviewer: {
        review: async () => {
          reviewCount += 1;
          throw new Error("Approval must not run for an ordinary read");
        },
      },
    });

    const output = await router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: safeRead.definition.capabilityId,
      arguments: {},
      scope: { region: "cn-north-4" },
    });

    expect(output.status).toBe("completed");
    expect(reviewCount).toBe(0);
  });

  it("uses the build-generated fixed launcher by default", async () => {
    const router = await RouterCore.create({
      capabilities: [safeRead],
      adapters: [successfulAdapter()],
      approvalManifestUrl: pathToFileURL(resolve("dist/runtime-manifest.json")),
      identityProvider: async () => structuredClone(baseIdentity),
      contractDirectory,
    });

    await expect(
      router.execute({
        schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
        capabilityId: safeRead.definition.capabilityId,
        arguments: {},
        scope: {},
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("binds a companion receipt and consumes it once before dispatch", async () => {
    const router = await createRouter();
    const preview = await createPreview(router);

    const output = await router.execute({
      ...dangerousInput,
      previewId: preview.previewId,
    });

    expect(output).toMatchObject({
      status: "completed",
      execution: { executor: "provider-mcp", effectiveAccountId: "account-1" },
    });
    await expect(
      router.execute({
        ...dangerousInput,
        previewId: preview.previewId,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REPLAYED" });
  });

  it("rejects changed parameters and executor after preview", async () => {
    let reviewCount = 0;
    const router = await createRouter({
      reviewer: {
        review: async () => {
          reviewCount += 1;
          return null;
        },
      },
    });
    const preview = await createPreview(router);

    await expect(
      router.execute({
        ...dangerousInput,
        arguments: { name: "changed-server" },
        previewId: preview.previewId,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(
      router.execute({
        ...dangerousInput,
        executorPreference: "koocli",
        previewId: preview.previewId,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_LOCKED" });
    expect(reviewCount).toBe(0);
  });

  it("allows only one concurrent dispatch for the same preview", async () => {
    let dispatchCount = 0;
    let releaseDispatch = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const provider = adapter("provider-mcp", async (request) => {
      dispatchCount += 1;
      await blocked;
      return {
        result: { serverId: "server-1" },
        effectiveAccountId: request.identity.accountIdentity.accountId,
        effectiveProjectId: request.scope.project,
        effectiveRegion: request.scope.region,
      };
    });
    const router = await createRouter({ provider });
    const preview = await createPreview(router);
    const approvedInput = {
      ...dangerousInput,
      previewId: preview.previewId,
    };

    const first = router.execute(approvedInput);
    const second = router.execute(approvedInput);
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setImmediate(resolve));
    releaseDispatch();
    const results = await settled;

    expect(dispatchCount).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "APPROVAL_REPLAYED" },
    });
  });

  it("keeps a preview consumed after OUTCOME_UNKNOWN and never falls back", async () => {
    let koocliDispatchCount = 0;
    const provider = adapter("provider-mcp", async () => {
      throw new RouterError(
        "OUTCOME_UNKNOWN",
        "Reference provider accepted the request but timed out",
      );
    });
    const koocli = adapter("koocli", async () => {
      koocliDispatchCount += 1;
      return {
        result: { serverId: "unexpected" },
        effectiveAccountId: "account-1",
      };
    });
    const router = await createRouter({ provider, koocli });
    const preview = await createPreview(router);
    const approvedInput = {
      ...dangerousInput,
      previewId: preview.previewId,
    };

    await expect(router.execute(approvedInput)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    await expect(router.execute(approvedInput)).rejects.toMatchObject({
      code: "APPROVAL_REPLAYED",
    });
    expect(koocliDispatchCount).toBe(0);
  });

  it("invalidates approval when credential generation changes", async () => {
    let identity = structuredClone(baseIdentity);
    const router = await createRouter({
      identityProvider: async () => structuredClone(identity),
    });
    const preview = await createPreview(router);
    identity = {
      ...identity,
      credentialGeneration: "7cecf2cb-2a11-40ef-899a-7290e6ad66c5",
    };

    await expect(
      router.execute({
        ...dangerousInput,
        previewId: preview.previewId,
      }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
    await expect(
      router.execute({ ...dangerousInput, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "APPROVAL_REPLAYED" });
  });

  it("invalidates the preview when the user rejects approval", async () => {
    let reviewCount = 0;
    const router = await createRouter({
      reviewer: {
        review: async () => {
          reviewCount += 1;
          return null;
        },
      },
    });
    const preview = await createPreview(router);
    const secondInput = { ...dangerousInput, previewId: preview.previewId };

    await expect(router.execute(secondInput)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
      message: "Trusted approval was rejected by the user",
    });
    await expect(router.execute(secondInput)).rejects.toMatchObject({
      code: "APPROVAL_REPLAYED",
    });
    expect(reviewCount).toBe(1);
  });

  it("keeps an unexpired preview retryable after a companion process failure", async () => {
    let reviewCount = 0;
    const launcher = await trustedReviewer();
    const router = await createRouter({
      reviewer: {
        review: async (context) => {
          reviewCount += 1;
          if (reviewCount === 1) {
            throw new ApprovalError(
              "APPROVAL_PROCESS_FAILED",
              "Fixture companion failed before approval",
            );
          }
          return launcher.review(context);
        },
      },
    });
    const preview = await createPreview(router);
    const secondInput = { ...dangerousInput, previewId: preview.previewId };

    await expect(router.execute(secondInput)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
      retryable: true,
    });
    await expect(router.execute(secondInput)).resolves.toMatchObject({
      status: "completed",
    });
    expect(reviewCount).toBe(2);
  });

  it("rechecks credential generation after the user approves", async () => {
    let identity = structuredClone(baseIdentity);
    const launcher = await trustedReviewer();
    const router = await createRouter({
      identityProvider: async () => structuredClone(identity),
      reviewer: {
        review: async (context) => {
          const receipt = await launcher.review(context);
          identity = {
            ...identity,
            credentialGeneration: "7cecf2cb-2a11-40ef-899a-7290e6ad66c5",
          };
          return receipt;
        },
      },
    });
    const preview = await createPreview(router);

    await expect(
      router.execute({ ...dangerousInput, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
    await expect(
      router.execute({ ...dangerousInput, previewId: preview.previewId }),
    ).rejects.toMatchObject({ code: "APPROVAL_REPLAYED" });
  });

  it("redacts declared sensitive output paths before returning to the Agent", async () => {
    const sensitiveRead: RouterCapabilityRegistration = {
      ...safeRead,
      definition: {
        ...safeRead.definition,
        outputPolicy: {
          ...safeRead.definition.outputPolicy,
          sensitivePaths: ["/buckets"],
        },
      },
    };
    const router = await createRouter({ capabilities: [sensitiveRead] });

    await expect(
      router.execute({
        schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
        capabilityId: sensitiveRead.definition.capabilityId,
        arguments: {},
        scope: {},
      }),
    ).resolves.toMatchObject({
      status: "completed",
      result: { buckets: "[REDACTED]" },
    });
  });
});
