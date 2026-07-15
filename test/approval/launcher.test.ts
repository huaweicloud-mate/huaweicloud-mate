import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import type { ApprovalSigningContext } from "../../src/approval/types.js";
import { contractFileNames } from "../../src/contracts/manifest.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const fixturePath = resolve("test/fixtures/approval-companion-child.mjs");
const bootstrapFixturePath = resolve(
  "test/fixtures/approval-companion-error-child.mjs",
);

function signingContext(): ApprovalSigningContext {
  return {
    request: {
      schemaVersion: "huaweicloud-agent-approval-request/v1",
      status: "confirmation_required",
      previewId: "preview_launcher_abcdefghijklmnopqrstuvwxyz012345",
      challenge: "challenge_launcher_abcdefghijklmnopqrstuvwxyz0123",
      parameterDigest: `sha256:${"a".repeat(64)}`,
      summary: {
        capabilityId: "huaweicloud.ecs.server.create.v1",
        executor: "provider-mcp",
        operationKind: "write",
        riskTags: ["cost"],
        scope: { region: "cn-north-4", project: "project-1" },
        resources: ["ecs/server/test"],
        effects: ["Create one test server"],
      },
      allowedIssuerIds: ["huaweicloud-mate.local-approval"],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
    credentialGeneration: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
    accountIdentity: { accountId: "account-1", domainId: "domain-1" },
  };
}

async function verifiedBootstrapArtifacts() {
  const entryDigest = await sha256File(bootstrapFixturePath);
  return {
    entryDigest,
    artifacts: [
      {
        path: bootstrapFixturePath,
        expectedSha256: entryDigest,
        runtimePath: "approval/companion-process.js",
      },
      ...(await Promise.all(
        contractFileNames.map(async (fileName) => {
          const path = resolve("docs/契约", fileName);
          return {
            path,
            expectedSha256: await sha256File(path),
            runtimePath: `contracts/schema/${fileName}`,
          };
        }),
      )),
    ],
  };
}

describe("approval companion launcher", () => {
  it("loads the build-generated fixed runtime manifest", async () => {
    await expect(
      ApprovalCompanionLauncher.fromRuntimeManifest(
        pathToFileURL(resolve("dist/runtime-manifest.json")),
        contractDirectory,
      ),
    ).resolves.toBeInstanceOf(ApprovalCompanionLauncher);
  });

  it("boots the build-generated companion from verified bytes without opening approval", async () => {
    const launcher = await ApprovalCompanionLauncher.fromRuntimeManifest(
      pathToFileURL(resolve("dist/runtime-manifest.json")),
      contractDirectory,
    );
    const context = signingContext();

    await expect(
      launcher.review({
        ...context,
        request: {
          ...context.request,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
  });

  it("exchanges a verified receipt over private parent-child IPC", async () => {
    const launcher = new ApprovalCompanionLauncher({
      entryPath: fixturePath,
      expectedSha256: await sha256File(fixturePath),
      contractDirectory,
      timeoutMs: 10_000,
    });

    const receipt = await launcher.review(signingContext());

    expect(receipt).not.toBeNull();
    expect(receipt?.approvalSessionId).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(receipt?.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("fails before spawn when the fixed artifact digest changes", async () => {
    const launcher = new ApprovalCompanionLauncher({
      entryPath: fixturePath,
      expectedSha256: `sha256:${"0".repeat(64)}`,
      contractDirectory,
      timeoutMs: 10_000,
    });

    await expect(launcher.review(signingContext())).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_INVALID",
    });
  });

  it("loads verified companion entry bytes through the private source pipe", async () => {
    const verified = await verifiedBootstrapArtifacts();
    const launcher = new ApprovalCompanionLauncher({
      entryPath: bootstrapFixturePath,
      expectedSha256: verified.entryDigest,
      artifacts: verified.artifacts,
      contractDirectory,
      timeoutMs: 10_000,
      loadVerifiedEntryBytes: true,
    });

    await expect(launcher.review(signingContext())).rejects.toMatchObject({
      code: "APPROVAL_PROCESS_FAILED",
      message: "Verified source bootstrap fixture",
    });
  });

  it("rejects oversized approval context before opening IPC", async () => {
    const launcher = new ApprovalCompanionLauncher({
      entryPath: fixturePath,
      expectedSha256: await sha256File(fixturePath),
      contractDirectory,
      timeoutMs: 10_000,
    });
    const ordinary = signingContext();
    const oversized: ApprovalSigningContext = {
      ...ordinary,
      request: {
        ...ordinary.request,
        summary: {
          ...ordinary.request.summary,
          effects: ["x".repeat(70_000)],
        },
      },
    };

    await expect(launcher.review(oversized)).rejects.toMatchObject({
      code: "APPROVAL_REQUEST_INVALID",
    });
  });

  it("checks every runtime artifact rather than only the child entry", async () => {
    const entryDigest = await sha256File(fixturePath);
    const launcher = new ApprovalCompanionLauncher({
      entryPath: fixturePath,
      expectedSha256: entryDigest,
      artifacts: [
        { path: fixturePath, expectedSha256: entryDigest },
        {
          path: resolve("src/approval/browser-ui.ts"),
          expectedSha256: `sha256:${"0".repeat(64)}`,
        },
      ],
      contractDirectory,
      timeoutMs: 10_000,
    });

    await expect(launcher.review(signingContext())).rejects.toMatchObject({
      code: "APPROVAL_ARTIFACT_INVALID",
    });
  });
});
