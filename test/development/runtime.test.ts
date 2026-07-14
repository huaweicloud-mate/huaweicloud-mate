import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import { createDevelopmentRuntime } from "../../src/development/runtime.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve(
  "test/fixtures/approval-companion-child.mjs",
);

describe("development reference runtime", () => {
  it("runs a no-cloud approval simulation and redacts its internal trace", async () => {
    const approvalReviewer = new ApprovalCompanionLauncher({
      entryPath: companionFixturePath,
      expectedSha256: await sha256File(companionFixturePath),
      contractDirectory,
      timeoutMs: 10_000,
    });
    const runtime = await createDevelopmentRuntime({
      approvalReviewer,
      contractDirectory,
    });
    const input = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.reference.change.simulate.v1",
      arguments: { name: "redaction-test" },
      scope: {},
    };
    const preview = await runtime.router.execute(input);
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected a development approval preview");
    }
    const receipt = await runtime.router.reviewPendingPreview(preview.previewId);
    if (receipt === null) {
      throw new Error("Expected the test companion to approve");
    }

    await expect(
      runtime.router.execute({
        ...input,
        previewId: preview.previewId,
        approvalReceipt: receipt,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      result: {
        mode: "development-reference",
        simulated: true,
        name: "redaction-test",
        internalTrace: "[REDACTED]",
      },
      execution: {
        effectiveAccountId: "development-reference-no-cloud",
      },
    });
  });
});
