import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ApprovalCompanionLauncher,
  sha256File,
} from "../../src/approval/launcher.js";
import { main } from "../../src/cli.js";
import { runApprovalDoctor } from "../../src/doctor/approval-doctor.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve(
  "test/fixtures/approval-companion-child.mjs",
);

describe("approval doctor", () => {
  it("runs a verified no-cloud challenge over private companion IPC", async () => {
    const reviewer = new ApprovalCompanionLauncher({
      entryPath: companionFixturePath,
      expectedSha256: await sha256File(companionFixturePath),
      contractDirectory,
      timeoutMs: 10_000,
    });

    await expect(runApprovalDoctor({ reviewer })).resolves.toEqual({
      ok: true,
      status: "passed",
      noCloudOperation: true,
      message: "Local approval companion challenge and receipt verification passed",
      issuerId: "huaweicloud-mate.local-approval",
    });
  });

  it("reports an explicit user rejection without retrying or cloud access", async () => {
    let reviewCount = 0;
    const report = await runApprovalDoctor({
      reviewer: {
        review: async () => {
          reviewCount += 1;
          return null;
        },
      },
    });

    expect(report).toMatchObject({
      ok: false,
      status: "rejected",
      noCloudOperation: true,
    });
    expect(reviewCount).toBe(1);
  });

  it("rejects conflicting doctor modes without opening approval", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      main(["doctor", "--contracts-only", "--approval-probe"]),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      "--contracts-only, --approval-probe, --koocli, and --hosts cannot be used together",
    );

    error.mockRestore();
  });
});
