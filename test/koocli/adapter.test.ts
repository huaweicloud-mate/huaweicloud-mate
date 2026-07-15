import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import {
  KooCliExecutorAdapter,
  KooCliInvocationError,
  type KooCliInvocationRequest,
  type KooCliInvocationResult,
  type KooCliSecureInvoker,
} from "../../src/koocli/adapter.js";
import { RouterCore } from "../../src/router/core.js";
import type {
  RouterCapabilityRegistration,
  RouterDispatchRequest,
  RouterExecutorAdapter,
} from "../../src/router/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

class CompatibleRunner implements HostCommandRunner {
  readonly executablePath: string;

  constructor(root: string) {
    this.executablePath = resolve(root, "system", "hcloud.exe");
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    return command === "hcloud" ? this.executablePath : undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    expect(executablePath).toBe(this.executablePath);
    expect(args).toEqual(["version"]);
    return {
      code: 0,
      signal: null,
      stdout: "KooCLI 7.2.12\n",
      stderr: "",
    };
  }
}

class FakeSecureInvoker implements KooCliSecureInvoker {
  available = true;
  readonly requests: KooCliInvocationRequest[] = [];
  result: KooCliInvocationResult = {
    result: { servers: ["server-1"] },
    effectiveAccountId: "account-1",
    effectiveProjectId: "project-1",
    effectiveRegion: "cn-north-4",
    requestId: "request-1",
  };
  failure?: KooCliInvocationError;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async invoke(request: KooCliInvocationRequest): Promise<KooCliInvocationResult> {
    this.requests.push(structuredClone(request));
    if (this.failure !== undefined) throw this.failure;
    return structuredClone(this.result);
  }
}

const capability: RouterCapabilityRegistration = {
  definition: {
    schemaVersion: "huaweicloud-agent-capability/v1-lite",
    capabilityId: "huaweicloud.ecs.server.list.v1",
    product: "ecs",
    summary: "List ECS servers through a fixed KooCLI mapping",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["servers"],
      properties: {
        servers: { type: "array", items: { type: "string" } },
      },
    },
    scope: { region: "required", project: "required" },
    operationKind: "read",
    riskTags: [],
    confirmationRequired: false,
    executors: {
      providerMcp: {
        providerId: "huaweicloud-ecs",
        tool: "ecs_list_servers",
        inputSchemaDigest: `sha256:${"a".repeat(64)}`,
      },
      koocli: { service: "ECS", operation: "ListServersDetails" },
    },
    defaultExecutor: "provider-mcp",
    outputPolicy: {
      sensitivePaths: [],
      maxBytes: 65_536,
      allowProviderText: false,
    },
  },
  summarize: () => ({
    resources: ["ECS server inventory"],
    effects: ["Read ECS server metadata"],
  }),
};

function dispatchRequest(): RouterDispatchRequest {
  return {
    capability: capability.definition,
    arguments: { limit: 10 },
    scope: { region: "cn-north-4", project: "project-1" },
    identity: {
      credentialGeneration: "generation-1",
      accountIdentity: { accountId: "account-1", domainId: "domain-1" },
    },
    correlationId: "correlation-1",
  };
}

describe("secure KooCLI adapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(invoker?: KooCliSecureInvoker) {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-koocli-adapter-"));
    roots.push(root);
    const runner = new CompatibleRunner(root);
    return {
      root,
      runner,
      adapter: new KooCliExecutorAdapter({
        runtimeRoot: resolve(root, "runtime"),
        artifacts: [],
        runner,
        ...(invoker === undefined ? {} : { invoker }),
      }),
    };
  }

  it("keeps dispatch unavailable until a secure non-argv invoker is supplied", async () => {
    const { adapter } = await fixture();
    await expect(adapter.isAvailable(capability.definition)).resolves.toBe(false);
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("passes only fixed mapping, structured input and identity bindings", async () => {
    const invoker = new FakeSecureInvoker();
    const { adapter, runner } = await fixture(invoker);
    await expect(adapter.isAvailable(capability.definition)).resolves.toBe(true);
    await expect(adapter.execute(dispatchRequest())).resolves.toMatchObject({
      result: { servers: ["server-1"] },
      effectiveAccountId: "account-1",
      effectiveProjectId: "project-1",
      effectiveRegion: "cn-north-4",
    });
    expect(invoker.requests).toEqual([{
      executablePath: runner.executablePath,
      version: "7.2.12",
      service: "ECS",
      operation: "ListServersDetails",
      arguments: { limit: 10 },
      region: "cn-north-4",
      project: "project-1",
      credentialGeneration: "generation-1",
      expectedAccountId: "account-1",
      expectedDomainId: "domain-1",
      correlationId: "correlation-1",
    }]);
    expect(JSON.stringify(invoker.requests[0])).not.toMatch(/access.?key|secret|authorization/i);
  });

  it("rejects credential-shaped arguments before invoking the boundary", async () => {
    const invoker = new FakeSecureInvoker();
    const { adapter } = await fixture(invoker);
    await expect(adapter.execute({
      ...dispatchRequest(),
      arguments: { nested: { secretAccessKey: "forbidden" } },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(invoker.requests).toHaveLength(0);
  });

  it("normalizes timeout and result-unknown without exposing raw errors", async () => {
    const invoker = new FakeSecureInvoker();
    const { adapter } = await fixture(invoker);
    invoker.failure = new KooCliInvocationError("timeout");
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      retryable: true,
      message: "Secure KooCLI invocation failed",
    });
    invoker.failure = new KooCliInvocationError("outcome-unknown");
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      retryable: false,
    });
    const writeRequest = {
      ...dispatchRequest(),
      capability: { ...capability.definition, operationKind: "write" as const },
    };
    invoker.failure = new KooCliInvocationError("timeout");
    await expect(adapter.execute(writeRequest)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      retryable: false,
    });
  });

  it("rejects account, scope and oversized output mismatches", async () => {
    const invoker = new FakeSecureInvoker();
    const { adapter } = await fixture(invoker);
    invoker.result = { ...invoker.result, effectiveAccountId: "account-2" };
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "ACCOUNT_MISMATCH",
    });
    invoker.result = {
      ...invoker.result,
      effectiveAccountId: "account-1",
      effectiveRegion: "cn-east-3",
    };
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "INVALID_SCOPE",
    });
    invoker.result = {
      ...invoker.result,
      effectiveRegion: "cn-north-4",
      result: { servers: ["x".repeat(70_000)] },
    };
    await expect(adapter.execute(dispatchRequest())).rejects.toMatchObject({
      code: "OUTPUT_REJECTED",
    });
  });

  it("lets Router select KooCLI only before dispatch when provider is unavailable", async () => {
    const invoker = new FakeSecureInvoker();
    const { adapter } = await fixture(invoker);
    const provider: RouterExecutorAdapter = {
      executor: "provider-mcp",
      isAvailable: vi.fn(async () => false),
      execute: vi.fn(async () => {
        throw new Error("Unavailable provider must not execute");
      }),
    };
    const router = await RouterCore.create({
      capabilities: [capability],
      adapters: [provider, adapter],
      approvalReviewer: { review: async () => null },
      identityProvider: async () => dispatchRequest().identity,
      contractDirectory,
    });
    await expect(router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: capability.definition.capabilityId,
      arguments: { limit: 10 },
      scope: { region: "cn-north-4", project: "project-1" },
    })).resolves.toMatchObject({
      status: "completed",
      execution: { executor: "koocli" },
      result: { servers: ["server-1"] },
    });
    expect(provider.execute).not.toHaveBeenCalled();
    expect(invoker.requests).toHaveLength(1);
  });
});
