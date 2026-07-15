import { describe, expect, it, vi } from "vitest";

import type {
  ObsGetObjectTextResult,
  ObsListBucketsResult,
} from "../../src/providers/obs/client.js";
import {
  LocalObsSessionManager,
  ObsCredentialIdentityVerifier,
} from "../../src/providers/obs/session.js";

const credentials = {
  accessKey: "test-ak",
  secretKey: "test-sk",
  generation: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
};

describe("local OBS credential sessions", () => {
  it("binds identity, generation, route token and a maximum lifetime", async () => {
    let now = new Date("2026-07-14T00:00:00.000Z");
    const listBuckets = vi.fn(async (): Promise<ObsListBucketsResult> => ({
      ownerAccountId: "domain-123",
      buckets: [],
    }));
    const sessions = new LocalObsSessionManager({
      client: { listBuckets },
      now: () => now,
      providerInstanceId: "provider-instance-test",
    });
    const binding = await sessions.create(credentials, 900);

    expect(binding).toMatchObject({
      providerInstanceId: "provider-instance-test",
      credentialGeneration: credentials.generation,
      expiresAt: "2026-07-14T00:15:00.000Z",
      accountIdentity: { accountId: "domain-123", domainId: "domain-123" },
    });
    expect(binding.sessionId).not.toContain("test-ak");
    expect(binding.routeToken).not.toContain("test-sk");
    await expect(sessions.listBuckets(binding, "cn-north-4")).resolves.toMatchObject({
      ownerAccountId: "domain-123",
    });
    await expect(sessions.listBuckets({
      ...binding,
      routeToken: `${binding.routeToken}tampered`,
    })).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });

    now = new Date("2026-07-14T00:15:00.000Z");
    await expect(sessions.listBuckets(binding)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
  });

  it("uses an ephemeral session for auth identity verification", async () => {
    const sessions = new LocalObsSessionManager({
      client: {
        listBuckets: vi.fn(async () => ({ ownerAccountId: "domain-auth", buckets: [] })),
      },
    });
    const verifier = new ObsCredentialIdentityVerifier(sessions);

    await expect(verifier.verify(credentials)).resolves.toEqual({
      accountId: "domain-auth",
      domainId: "domain-auth",
    });
  });

  it("uses the same private session binding for bounded object text reads", async () => {
    const listBuckets = vi.fn(async (): Promise<ObsListBucketsResult> => ({
      ownerAccountId: "domain-123",
      buckets: [],
    }));
    const getObjectText = vi.fn(async (): Promise<ObsGetObjectTextResult> => ({
      bucketName: "private-notes",
      objectKey: "approved.txt",
      region: "cn-north-4",
      contentType: "text/plain",
      contentLength: 8,
      text: "approved",
    }));
    const sessions = new LocalObsSessionManager({
      client: { listBuckets, getObjectText },
    });
    const binding = await sessions.create(credentials);

    await expect(sessions.getObjectText(
      binding,
      "private-notes",
      "approved.txt",
      "cn-north-4",
    )).resolves.toMatchObject({ text: "approved" });
    expect(getObjectText).toHaveBeenCalledWith(expect.objectContaining({
      bucketName: "private-notes",
      objectKey: "approved.txt",
      region: "cn-north-4",
      accessKey: "test-ak",
      secretKey: "test-sk",
    }));
  });

  it("rejects account drift inside an established session", async () => {
    const listBuckets = vi
      .fn()
      .mockResolvedValueOnce({ ownerAccountId: "domain-123", buckets: [] })
      .mockResolvedValueOnce({ ownerAccountId: "domain-other", buckets: [] });
    const sessions = new LocalObsSessionManager({ client: { listBuckets } });
    const binding = await sessions.create(credentials);

    await expect(sessions.listBuckets(binding)).rejects.toMatchObject({
      code: "ACCOUNT_MISMATCH",
    });
    await expect(sessions.listBuckets(binding)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
  });
});
