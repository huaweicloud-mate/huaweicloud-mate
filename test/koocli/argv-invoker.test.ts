import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialStore } from "../../src/auth/credentials.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import type { StoredCredentials } from "../../src/auth/types.js";
import {
  AuthorizedArgvKooCliInvoker,
  NodeKooCliArgvProcessRunner,
  type KooCliArgvProcessRequest,
  type KooCliArgvProcessResult,
  type KooCliArgvProcessRunner,
} from "../../src/koocli/argv-invoker.js";

const generation = "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4";
const credentials: StoredCredentials = {
  schemaVersion: "huaweicloud-mate-credentials/v1",
  accessKey: "test-permanent-ak",
  secretKey: "test-permanent-sk",
  generation,
  accountIdentity: { accountId: "account-1", domainId: "domain-1" },
  validatedAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};

const permissions: CredentialPermissionPolicy = {
  secureDirectory: async () => undefined,
  secureFile: async () => undefined,
  verifyFile: async () => undefined,
};

function result(stdout: string): KooCliArgvProcessResult {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

class FakeArgvRunner implements KooCliArgvProcessRunner {
  readonly requests: KooCliArgvProcessRequest[] = [];
  next = result(JSON.stringify({ servers: ["server-1"], request_id: "request-1" }));

  async run(request: KooCliArgvProcessRequest): Promise<KooCliArgvProcessResult> {
    this.requests.push(structuredClone(request));
    return structuredClone(this.next);
  }
}

describe("authorized KooCLI argv invoker", () => {
  const roots: string[] = [];

  afterEach(async () => {
    delete process.env.HUAWEICLOUD_ACCESS_KEY;
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(configured = true) {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-koocli-argv-"));
    roots.push(root);
    const store = new CredentialStore({
      path: resolve(root, "credentials.json"),
      permissions,
    });
    if (configured) await store.replace(credentials, null);
    const runner = new FakeArgvRunner();
    const invoker = new AuthorizedArgvKooCliInvoker({ credentials: store, runner });
    return { runner, invoker };
  }

  function request() {
    return {
      executablePath: resolve("C:\\trusted", "hcloud.exe"),
      version: "7.2.12",
      service: "ECS",
      operation: "ListServersDetails",
      arguments: { limit: 10 },
      region: "cn-north-4",
      project: "project-1",
      credentialGeneration: generation,
      expectedAccountId: "account-1",
      expectedDomainId: "domain-1",
      correlationId: "correlation-1",
    } as const;
  }

  it("is unavailable until the shared permanent AK/SK is configured", async () => {
    const { invoker } = await fixture(false);
    await expect(invoker.isAvailable({
      executablePath: request().executablePath,
      version: "7.2.12",
    })).resolves.toBe(false);
  });

  it("uses the authorized non-profile argv mode with retry disabled", async () => {
    const { runner, invoker } = await fixture();

    await expect(invoker.invoke(request())).resolves.toEqual({
      result: { servers: ["server-1"], request_id: "request-1" },
      effectiveAccountId: "account-1",
      effectiveProjectId: "project-1",
      effectiveRegion: "cn-north-4",
      requestId: "request-1",
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.args).toEqual([
      "ECS",
      "ListServersDetails",
      "--limit=10",
      "--cli-mode=AKSK",
      `--cli-access-key=${credentials.accessKey}`,
      `--cli-secret-key=${credentials.secretKey}`,
      "--cli-agree-privacy-statement=true",
      "--cli-warning=false",
      "--cli-offline=true",
      "--cli-retry-count=0",
      "--cli-output=json",
      "--cli-skip-secure-verify=false",
      "--cli-query={count:length(servers),servers:servers[].{id:id,name:name,status:status},nextMarker:servers[-1].id}",
      "--cli-region=cn-north-4",
      "--project_id=project-1",
      "--cli-domain-id=domain-1",
    ]);
    expect(runner.requests[0]?.args.some((argument) =>
      argument.startsWith("--cli-profile="))).toBe(false);
  });

  it("rejects stale identity bindings before spawning KooCLI", async () => {
    const { runner, invoker } = await fixture();

    await expect(invoker.invoke({
      ...request(),
      credentialGeneration: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ failure: "account-mismatch" });
    await expect(invoker.invoke({
      ...request(),
      expectedAccountId: "account-2",
    })).rejects.toMatchObject({ failure: "account-mismatch" });
    expect(runner.requests).toHaveLength(0);
  });

  it("rejects reserved arguments and credential material echoed in output", async () => {
    const { runner, invoker } = await fixture();

    await expect(invoker.invoke({
      ...request(),
      arguments: { "cli-profile": "forbidden" },
    })).rejects.toMatchObject({ failure: "validation-failed" });
    expect(runner.requests).toHaveLength(0);

    await expect(invoker.invoke({
      ...request(),
      arguments: { project_id: "conflicting-project" },
    })).rejects.toMatchObject({ failure: "validation-failed" });
    expect(runner.requests).toHaveLength(0);

    runner.next = result(JSON.stringify({ value: credentials.secretKey }));
    await expect(invoker.invoke(request())).rejects.toMatchObject({
      failure: "validation-failed",
    });
  });

  it("rejects mappings that have not passed the static invocation review", async () => {
    const { runner, invoker } = await fixture();

    await expect(invoker.invoke({
      ...request(),
      operation: "DeleteServers",
    })).rejects.toMatchObject({ failure: "validation-failed" });
    expect(runner.requests).toHaveLength(0);
  });

  it("does not copy unrelated credential environment variables to the child", async () => {
    process.env.HUAWEICLOUD_ACCESS_KEY = "environment-secret";
    const runner = new NodeKooCliArgvProcessRunner();
    const child = await runner.run({
      executablePath: process.execPath,
      args: [
        "-e",
        "process.stdout.write(String(process.env.HUAWEICLOUD_ACCESS_KEY))",
      ],
      timeoutMs: 10_000,
    });

    expect(child.code).toBe(0);
    expect(child.stdout).toBe("undefined");
  });
});
