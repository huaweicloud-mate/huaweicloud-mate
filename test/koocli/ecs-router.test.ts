import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import { CredentialStore } from "../../src/auth/credentials.js";
import type { StoredCredentials } from "../../src/auth/types.js";
import { createDevelopmentRuntime } from "../../src/development/runtime.js";
import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import type {
  KooCliArgvProcessRequest,
  KooCliArgvProcessResult,
  KooCliArgvProcessRunner,
} from "../../src/koocli/argv-invoker.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve("test/fixtures/approval-companion-child.mjs");
const generation = "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4";
const serverId = "4d79fdd5-3bb0-4caa-a3c9-7df346e8f9f0";
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

class FakeArgvRunner implements KooCliArgvProcessRunner {
  readonly requests: KooCliArgvProcessRequest[] = [];

  async run(request: KooCliArgvProcessRequest): Promise<KooCliArgvProcessResult> {
    this.requests.push(structuredClone(request));
    return {
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        count: 1,
        servers: [{ id: serverId, name: "server-1", status: "ACTIVE" }],
        nextMarker: serverId,
      }),
      stderr: "",
      timedOut: false,
    };
  }
}

describe("ECS Router to KooCLI flow", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("does not release AK/SK until the sensitive inventory read is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-ecs-router-"));
    roots.push(root);
    const credentialsPath = resolve(root, "credentials.json");
    await new CredentialStore({ path: credentialsPath, permissions }).replace(
      credentials,
      null,
    );
    const argvRunner = new FakeArgvRunner();
    const hostRunner = new CompatibleRunner(root);
    const reviewer = new ApprovalCompanionLauncher({
      entryPath: companionFixturePath,
      expectedSha256: await sha256File(companionFixturePath),
      contractDirectory,
      timeoutMs: 10_000,
    });
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      approvalReviewer: reviewer,
      credentialsPath,
      credentialPermissions: permissions,
      runtimeRoot: resolve(root, "runtime"),
      koocliArtifacts: [],
      koocliRunner: hostRunner,
      koocliArgvRunner: argvRunner,
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.ecs.server.list.v1",
      arguments: { limit: 10 },
      scope: { region: "cn-north-4", project: "project-1" },
    };

    const preview = await runtime.router.execute(input);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      summary: {
        operationKind: "read",
        riskTags: ["sensitive-read"],
        executor: "koocli",
      },
    });
    expect(argvRunner.requests).toHaveLength(0);
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an ECS confirmation preview");
    }

    await expect(runtime.router.execute({
      ...input,
      previewId: preview.previewId,
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        count: 1,
        servers: [{ id: serverId, name: "server-1", status: "ACTIVE" }],
        nextMarker: serverId,
      },
      execution: {
        executor: "koocli",
        effectiveAccountId: "account-1",
        effectiveProjectId: "project-1",
        effectiveRegion: "cn-north-4",
      },
    });
    expect(argvRunner.requests).toHaveLength(1);
    expect(argvRunner.requests[0]?.args).toContain("--project_id=project-1");
    expect(argvRunner.requests[0]?.args).toContain(
      "--cli-query={count:length(servers),servers:servers[].{id:id,name:name,status:status},nextMarker:servers[-1].id}",
    );
    expect(argvRunner.requests[0]?.args).toContain(
      `--cli-access-key=${credentials.accessKey}`,
    );
    expect(argvRunner.requests[0]?.args).toContain(
      `--cli-secret-key=${credentials.secretKey}`,
    );
  });
});
