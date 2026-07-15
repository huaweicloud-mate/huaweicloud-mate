import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import { main, type CliDependencies } from "../../src/cli.js";
import { LocalObsSessionManager } from "../../src/providers/obs/session.js";

const permissions: CredentialPermissionPolicy = {
  secureDirectory: async () => undefined,
  secureFile: async () => undefined,
  verifyFile: async () => undefined,
};

describe("auth CLI", () => {
  let root: string;
  let dependencies: CliDependencies;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-auth-cli-"));
    const answers = ["cli-test-ak", "cli-test-sk"];
    dependencies = {
      credentialsPath: resolve(root, "credentials.json"),
      credentialPermissions: permissions,
      credentialPrompter: {
        readSecret: vi.fn(async () => answers.shift() ?? ""),
      },
      credentialIdentityVerifier: {
        verify: vi.fn(async () => ({ accountId: "account-cli" })),
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("supports set/status/remove without exposing secret material", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(main(["auth", "set", "--json"], dependencies)).resolves.toBe(0);
    await expect(main(["auth", "status", "--json"], dependencies)).resolves.toBe(0);
    await expect(main(["auth", "remove", "--json"], dependencies)).resolves.toBe(0);

    const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(output).toContain("account-cli");
    expect(output).not.toContain("cli-test-ak");
    expect(output).not.toContain("cli-test-sk");
    expect(output).not.toContain("credentialGeneration");
  });

  it("rejects credentials passed as command arguments", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      main(["auth", "set", "--ak", "forbidden"], dependencies),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith("Unknown auth option: --ak");
  });

  it("uses the bundled read-only OBS identity verifier by default", async () => {
    const answers = ["bundled-ak", "bundled-sk"];
    const listBuckets = vi.fn(async () => ({
      ownerAccountId: "bundled-domain",
      buckets: [],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["auth", "set", "--json"], {
      credentialsPath: resolve(root, "bundled-credentials.json"),
      credentialPermissions: permissions,
      credentialPrompter: {
        readSecret: vi.fn(async () => answers.shift() ?? ""),
      },
      obsSessions: new LocalObsSessionManager({ client: { listBuckets } }),
    })).resolves.toBe(0);

    expect(listBuckets).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join("\n")).toContain("bundled-domain");
    expect(log.mock.calls.flat().join("\n")).not.toContain("bundled-sk");
  });
});
