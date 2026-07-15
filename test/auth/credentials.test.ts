import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialStore } from "../../src/auth/credentials.js";
import { AuthError } from "../../src/auth/errors.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import type { StoredCredentials } from "../../src/auth/types.js";

class TestPermissions implements CredentialPermissionPolicy {
  readonly secureDirectory = vi.fn(async () => undefined);
  readonly secureFile = vi.fn(async () => undefined);
  readonly verifyFile = vi.fn(async () => undefined);
}

const record: StoredCredentials = {
  schemaVersion: "huaweicloud-mate-credentials/v1",
  accessKey: "test-access-key",
  secretKey: "test-secret-key",
  generation: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
  accountIdentity: { accountId: "account-123", domainId: "domain-456" },
  validatedAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

describe("CredentialStore", () => {
  let root: string;
  let path: string;
  let permissions: TestPermissions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-auth-store-"));
    path = resolve(root, "data", "credentials.json");
    permissions = new TestPermissions();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates and reads a strict credential snapshot", async () => {
    const store = new CredentialStore({ path, permissions });
    const created = await store.replace(record, null);

    expect(created.credentials).toEqual(record);
    await expect(store.read()).resolves.toEqual(created);
    expect(permissions.secureDirectory).toHaveBeenCalledOnce();
    expect(permissions.secureFile).toHaveBeenCalledOnce();
    expect(permissions.verifyFile).toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toContain("test-secret-key");
  });

  it("rejects stale writers and stale removals", async () => {
    const store = new CredentialStore({ path, permissions });
    const created = await store.replace(record, null);
    const updated = await store.replace(
      { ...record, updatedAt: "2026-07-14T00:00:01.000Z" },
      created.sha256,
    );

    await expect(store.replace(record, created.sha256)).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_CONFLICT",
    });
    await expect(store.remove(created.sha256)).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_CONFLICT",
    });
    await expect(store.remove(updated.sha256)).resolves.toBeUndefined();
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("rejects unknown fields and never parses an oversized file", async () => {
    const store = new CredentialStore({ path, permissions });
    await store.replace(record, null);
    await writeFile(
      path,
      JSON.stringify({ ...record, unexpected: true }),
      "utf8",
    );
    await expect(store.read()).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
    });

    await writeFile(path, Buffer.alloc(32 * 1024 + 1, 65));
    await expect(store.read()).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_INVALID",
    });
  });

  it("rejects SecurityToken and profile fields outside the permanent AK/SK schema", async () => {
    const store = new CredentialStore({ path, permissions });
    await store.replace(record, null);

    for (const extra of [
      { securityToken: "not-supported" },
      { profile: "not-supported" },
      { password: "not-supported" },
    ]) {
      await writeFile(path, JSON.stringify({ ...record, ...extra }), "utf8");
      await expect(store.read()).rejects.toMatchObject({
        code: "AUTH_CREDENTIALS_INVALID",
      });
    }
  });

  it("refuses to read when the permission policy rejects the file", async () => {
    const store = new CredentialStore({ path, permissions });
    await store.replace(record, null);
    permissions.verifyFile.mockRejectedValueOnce(
      new AuthError("AUTH_CREDENTIALS_PERMISSIONS", "broad ACL"),
    );
    await expect(store.read()).rejects.toMatchObject({
      code: "AUTH_CREDENTIALS_PERMISSIONS",
    });
  });
});
