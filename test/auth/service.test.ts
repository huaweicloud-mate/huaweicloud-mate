import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialStore } from "../../src/auth/credentials.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import { AuthService } from "../../src/auth/service.js";
import type {
  CredentialIdentityVerifier,
  CredentialPrompter,
} from "../../src/auth/types.js";

const permissions: CredentialPermissionPolicy = {
  secureDirectory: async () => undefined,
  secureFile: async () => undefined,
  verifyFile: async () => undefined,
};

describe("AuthService", () => {
  let root: string;
  let store: CredentialStore;
  let prompter: CredentialPrompter;
  let verifier: CredentialIdentityVerifier;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-auth-service-"));
    store = new CredentialStore({
      path: resolve(root, "credentials.json"),
      permissions,
    });
    const answers = ["test-ak", "test-sk"];
    prompter = { readSecret: vi.fn(async () => answers.shift() ?? "") };
    verifier = {
      verify: vi.fn(async () => ({ accountId: "account-123", domainId: "domain-456" })),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("verifies identity before persisting a fresh generation", async () => {
    const service = new AuthService({
      store,
      prompter,
      identityVerifier: verifier,
      now: () => new Date("2026-07-14T01:02:03.000Z"),
      createGeneration: () => "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
    });

    await expect(service.set()).resolves.toEqual({
      status: "configured",
      changed: true,
      accountIdentity: { accountId: "account-123", domainId: "domain-456" },
      updatedAt: "2026-07-14T01:02:03.000Z",
      warnings: [],
    });
    await expect(service.status()).resolves.toEqual({
      configured: true,
      updatedAt: "2026-07-14T01:02:03.000Z",
      accountIdentity: { accountId: "account-123", domainId: "domain-456" },
    });
    await expect(service.routerIdentity()).resolves.toEqual({
      credentialGeneration: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
      accountIdentity: { accountId: "account-123", domainId: "domain-456" },
    });
    expect(verifier.verify).toHaveBeenCalledWith({
      accessKey: "test-ak",
      secretKey: "test-sk",
      generation: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
    });
  });

  it("does not persist credentials when identity verification fails", async () => {
    verifier = { verify: vi.fn(async () => { throw new Error("provider detail"); }) };
    const service = new AuthService({ store, prompter, identityVerifier: verifier });

    await expect(service.set()).rejects.toMatchObject({
      code: "AUTH_IDENTITY_VERIFICATION_FAILED",
      message: "Huawei Cloud credentials could not be verified",
    });
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("removes credentials and reports revocation failures without restoring secrets", async () => {
    const revoker = {
      revokeGeneration: vi.fn(async () => { throw new Error("offline"); }),
    };
    const service = new AuthService({
      store,
      prompter,
      identityVerifier: verifier,
      sessionRevoker: revoker,
      createGeneration: () => "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
    });
    await service.set();

    await expect(service.remove()).resolves.toMatchObject({
      status: "removed",
      changed: true,
      warnings: [expect.stringContaining("bounded")],
    });
    await expect(store.read()).resolves.toBeUndefined();
    expect(revoker.revokeGeneration).toHaveBeenCalledWith(
      "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
    );
    await expect(service.remove()).resolves.toEqual({
      status: "not-configured",
      changed: false,
      warnings: [],
    });
  });
});
