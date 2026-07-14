import { randomBytes, randomUUID } from "node:crypto";

import { sha256String } from "../approval/canonical.js";
import { approvalIssuerId } from "../approval/constants.js";
import { ApprovalError } from "../approval/errors.js";
import { ApprovalCompanionLauncher } from "../approval/launcher.js";
import type {
  ApprovalReviewer,
  ApprovalSigningContext,
} from "../approval/types.js";

export type ApprovalProbeStatus = "passed" | "rejected" | "failed";

export interface ApprovalDoctorReport {
  readonly ok: boolean;
  readonly status: ApprovalProbeStatus;
  readonly noCloudOperation: true;
  readonly message: string;
  readonly issuerId?: string;
  readonly errorCode?: string;
}

export interface ApprovalDoctorOptions {
  readonly reviewer?: ApprovalReviewer;
  readonly manifestUrl?: URL;
  readonly contractDirectory?: URL;
  readonly now?: () => Date;
}

function opaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function probeContext(now: Date): ApprovalSigningContext {
  return {
    request: {
      schemaVersion: "huaweicloud-agent-approval-request/v1",
      status: "confirmation_required",
      previewId: opaqueId(),
      challenge: opaqueId(),
      parameterDigest: sha256String(
        "huaweicloud-mate local approval doctor probe v1",
      ),
      summary: {
        capabilityId: "huaweicloud.mate.approval.probe.v1",
        executor: "provider-mcp",
        operationKind: "read",
        riskTags: ["sensitive-read"],
        scope: {},
        resources: ["Local approval companion"],
        effects: [
          "Verify one local approval receipt; no credential or cloud request is used",
        ],
      },
      allowedIssuerIds: [approvalIssuerId],
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    },
    credentialGeneration: randomUUID(),
    accountIdentity: { accountId: "local-doctor-no-cloud" },
  };
}

export async function runApprovalDoctor(
  options: ApprovalDoctorOptions = {},
): Promise<ApprovalDoctorReport> {
  const now = options.now?.() ?? new Date();
  const context = probeContext(now);
  try {
    const reviewer =
      options.reviewer ??
      (await ApprovalCompanionLauncher.fromRuntimeManifest(
        options.manifestUrl,
        options.contractDirectory,
      ));
    const receipt = await reviewer.review(context);
    if (receipt === null) {
      return {
        ok: false,
        status: "rejected",
        noCloudOperation: true,
        message: "Local approval probe was rejected by the user",
      };
    }
    if (
      receipt.issuerId !== approvalIssuerId ||
      receipt.previewId !== context.request.previewId
    ) {
      return {
        ok: false,
        status: "failed",
        noCloudOperation: true,
        message: "Local approval probe returned an unexpected receipt binding",
        errorCode: "APPROVAL_INVALID",
      };
    }
    return {
      ok: true,
      status: "passed",
      noCloudOperation: true,
      message: "Local approval companion challenge and receipt verification passed",
      issuerId: receipt.issuerId,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      noCloudOperation: true,
      message: "Local approval companion probe failed",
      errorCode:
        error instanceof ApprovalError ? error.code : "APPROVAL_PROCESS_FAILED",
    };
  }
}
