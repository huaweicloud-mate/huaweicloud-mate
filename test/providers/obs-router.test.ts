import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import { CredentialStore } from "../../src/auth/credentials.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import { createDevelopmentRuntime } from "../../src/development/runtime.js";
import { LocalObsSessionManager } from "../../src/providers/obs/session.js";

const permissions: CredentialPermissionPolicy = {
  secureDirectory: async () => undefined,
  secureFile: async () => undefined,
  verifyFile: async () => undefined,
};
const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve("test/fixtures/approval-companion-child.mjs");

describe("OBS Router integration", () => {
  let root: string;
  let credentialsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-obs-router-"));
    credentialsPath = resolve(root, "credentials.json");
    const store = new CredentialStore({ path: credentialsPath, permissions });
    await store.replace({
      schemaVersion: "huaweicloud-mate-credentials/v1",
      accessKey: "test-ak",
      secretKey: "test-sk",
      generation: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
      accountIdentity: { accountId: "domain-123", domainId: "domain-123" },
      validatedAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    }, null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("runs real search, describe and read execution through the OBS provider", async () => {
    const listBuckets = vi.fn(async () => ({
      ownerAccountId: "domain-123",
      buckets: [{
        name: "bucket-one",
        creationDate: "2026-07-01T00:00:00.000Z",
        location: "cn-north-4",
        type: "OBJECT" as const,
      }],
      requestId: "obs-request-123",
    }));
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({ client: { listBuckets } }),
      approvalReviewer: { review: vi.fn(async () => null) },
    });

    expect(runtime.catalog.search({
      schemaVersion: "huaweicloud-agent-search-input/v1-lite",
      query: "OBS bucket",
      operationKind: "read",
    }).capabilities).toContainEqual(
      expect.objectContaining({ capabilityId: "huaweicloud.obs.bucket.list.v1" }),
    );
    expect(runtime.catalog.describe({
      schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.list.v1",
    }).capability).toMatchObject({
      operationKind: "read",
      confirmationRequired: false,
    });
    await expect(runtime.router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.list.v1",
      arguments: {},
      scope: { region: "cn-north-4" },
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        ownerAccountId: "domain-123",
        buckets: [{ name: "bucket-one", location: "cn-north-4" }],
      },
      execution: {
        executor: "provider-mcp",
        effectiveAccountId: "domain-123",
        effectiveRegion: "cn-north-4",
        requestId: "obs-request-123",
      },
    });
    expect(listBuckets).toHaveBeenCalledTimes(2);
  });

  it("fails closed before network access when auth is absent", async () => {
    await rm(credentialsPath, { force: true });
    const listBuckets = vi.fn();
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({ client: { listBuckets } }),
      approvalReviewer: { review: vi.fn(async () => null) },
    });

    await expect(runtime.router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: "huaweicloud.obs.bucket.list.v1",
      arguments: {},
      scope: {},
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(listBuckets).not.toHaveBeenCalled();
  });

  it("requires trusted approval before dispatching a real OBS write capability", async () => {
    const listBuckets = vi.fn(async () => ({
      ownerAccountId: "domain-123",
      buckets: [],
    }));
    const createBucket = vi.fn(async () => ({
      bucketName: "approval-test-bucket",
      region: "cn-north-4",
      location: "/approval-test-bucket",
      requestId: "create-request-456",
    }));
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({
        client: { listBuckets, createBucket },
      }),
      approvalReviewer: new ApprovalCompanionLauncher({
        entryPath: companionFixturePath,
        expectedSha256: await sha256File(companionFixturePath),
        contractDirectory,
        timeoutMs: 10_000,
      }),
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.obs.bucket.create.v1",
      arguments: { bucketName: "approval-test-bucket" },
      scope: { region: "cn-north-4" },
    };

    const preview = await runtime.router.execute(input);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      summary: {
        operationKind: "write",
        riskTags: ["privileged", "cost"],
        resources: ["obs/bucket/approval-test-bucket"],
      },
    });
    expect(createBucket).not.toHaveBeenCalled();
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an OBS approval preview");
    }

    await expect(runtime.router.execute({
      ...input,
      previewId: preview.previewId,
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        bucketName: "approval-test-bucket",
        region: "cn-north-4",
      },
      execution: {
        requestId: "create-request-456",
        effectiveAccountId: "domain-123",
      },
    });
    expect(createBucket).toHaveBeenCalledOnce();
  }, 20_000);

  it("requires trusted approval before reading bounded object text into Agent context", async () => {
    const listBuckets = vi.fn(async () => ({
      ownerAccountId: "domain-123",
      buckets: [],
    }));
    const getObjectText = vi.fn(async () => ({
      bucketName: "sensitive-notes",
      objectKey: "reviews/approved.txt",
      region: "cn-north-4",
      contentType: "text/plain" as const,
      contentLength: 26,
      text: "approved confidential text",
      etag: "object-etag",
      requestId: "read-request-321",
    }));
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({
        client: { listBuckets, getObjectText },
      }),
      approvalReviewer: new ApprovalCompanionLauncher({
        entryPath: companionFixturePath,
        expectedSha256: await sha256File(companionFixturePath),
        contractDirectory,
        timeoutMs: 10_000,
      }),
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.obs.object.text.read.v1",
      arguments: {
        bucketName: "sensitive-notes",
        objectKey: "reviews/approved.txt",
      },
      scope: { region: "cn-north-4" },
    };

    expect(runtime.catalog.describe({
      schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
      capabilityId: input.capabilityId,
    }).capability).toMatchObject({
      operationKind: "read",
      riskTags: ["sensitive-read"],
      confirmationRequired: true,
    });
    const preview = await runtime.router.execute(input);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      summary: {
        operationKind: "read",
        riskTags: ["sensitive-read"],
        resources: ["obs/object/sensitive-notes/reviews/approved.txt"],
      },
    });
    expect(getObjectText).not.toHaveBeenCalled();
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an OBS sensitive-read approval preview");
    }

    await expect(runtime.router.execute({
      ...input,
      previewId: preview.previewId,
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        bucketName: "sensitive-notes",
        objectKey: "reviews/approved.txt",
        text: "approved confidential text",
      },
      execution: {
        executor: "provider-mcp",
        requestId: "read-request-321",
        effectiveAccountId: "domain-123",
        effectiveRegion: "cn-north-4",
      },
    });
    expect(getObjectText).toHaveBeenCalledOnce();
  }, 20_000);

  it("rejects credential-like material returned by an approved object read", async () => {
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({
        client: {
          listBuckets: vi.fn(async () => ({
            ownerAccountId: "domain-123",
            buckets: [],
          })),
          getObjectText: vi.fn(async () => ({
            bucketName: "sensitive-notes",
            objectKey: "leaked.txt",
            region: "cn-north-4",
            contentType: "text/plain" as const,
            contentLength: 32,
            text: "Authorization: forbidden-secret",
          })),
        },
      }),
      approvalReviewer: new ApprovalCompanionLauncher({
        entryPath: companionFixturePath,
        expectedSha256: await sha256File(companionFixturePath),
        contractDirectory,
        timeoutMs: 10_000,
      }),
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.obs.object.text.read.v1",
      arguments: { bucketName: "sensitive-notes", objectKey: "leaked.txt" },
      scope: { region: "cn-north-4" },
    };
    const preview = await runtime.router.execute(input);
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an OBS sensitive-read approval preview");
    }

    await expect(runtime.router.execute({
      ...input,
      previewId: preview.previewId,
    })).rejects.toMatchObject({ code: "OUTPUT_REJECTED" });
  }, 20_000);

  it("requires trusted approval before permanently deleting an empty OBS bucket", async () => {
    const listBuckets = vi.fn(async () => ({
      ownerAccountId: "domain-123",
      buckets: [],
    }));
    const deleteBucket = vi.fn(async () => ({
      bucketName: "approval-test-bucket",
      region: "cn-north-4",
      deleted: true as const,
      requestId: "delete-request-789",
    }));
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      credentialsPath,
      credentialPermissions: permissions,
      obsSessions: new LocalObsSessionManager({
        client: { listBuckets, deleteBucket },
      }),
      approvalReviewer: new ApprovalCompanionLauncher({
        entryPath: companionFixturePath,
        expectedSha256: await sha256File(companionFixturePath),
        contractDirectory,
        timeoutMs: 10_000,
      }),
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.obs.bucket.delete.v1",
      arguments: { bucketName: "approval-test-bucket" },
      scope: { region: "cn-north-4" },
    };

    const preview = await runtime.router.execute(input);
    expect(preview).toMatchObject({
      status: "confirmation_required",
      summary: {
        operationKind: "write",
        riskTags: ["destructive", "privileged"],
        resources: ["obs/bucket/approval-test-bucket"],
      },
    });
    expect(deleteBucket).not.toHaveBeenCalled();
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an OBS deletion approval preview");
    }

    await expect(runtime.router.execute({
      ...input,
      previewId: preview.previewId,
    })).resolves.toMatchObject({
      status: "completed",
      result: {
        bucketName: "approval-test-bucket",
        region: "cn-north-4",
        deleted: true,
      },
      execution: {
        requestId: "delete-request-789",
        effectiveAccountId: "domain-123",
      },
    });
    expect(deleteBucket).toHaveBeenCalledOnce();
  }, 20_000);
});
