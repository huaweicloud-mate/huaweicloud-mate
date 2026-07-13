import { verify } from "node:crypto";

import { approvalReceiptSigningPayload } from "./canonical.js";
import {
  approvalIssuerId,
  approvalSignatureAlgorithm,
  approvalVerifierKeyId,
  maxApprovalClockSkewMs,
  maxApprovalReceiptTtlMs,
} from "./constants.js";
import { ApprovalError } from "./errors.js";
import { importApprovalSessionPublicKey } from "./session-key.js";
import type {
  ApprovalReceipt,
  ApprovalSessionBinding,
  ExpectedApprovalBinding,
  UnsignedApprovalReceipt,
} from "./types.js";
import { ContractRegistry } from "../contracts/registry.js";

function unsignedReceipt(receipt: ApprovalReceipt): UnsignedApprovalReceipt {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function assertExpectedFields(
  receipt: ApprovalReceipt,
  expected: ExpectedApprovalBinding,
): void {
  const fields = [
    "issuerId",
    "approvalSessionId",
    "previewId",
    "challengeDigest",
    "parameterDigest",
    "executor",
    "credentialGeneration",
    "accountIdentityDigest",
    "scopeDigest",
  ] as const;
  for (const field of fields) {
    if (receipt[field] !== expected[field]) {
      throw new ApprovalError(
        "APPROVAL_INVALID",
        `Approval receipt ${field} does not match the pending preview`,
      );
    }
  }
}

export class TrustedApprovalVerifier {
  readonly #publicKey;
  readonly #consumedPreviewIds = new Set<string>();

  private constructor(
    private readonly binding: ApprovalSessionBinding,
    private readonly contracts: ContractRegistry,
  ) {
    this.#publicKey = importApprovalSessionPublicKey(binding);
  }

  static async create(
    binding: ApprovalSessionBinding,
    contractDirectory?: URL,
  ): Promise<TrustedApprovalVerifier> {
    if (
      binding.issuerId !== approvalIssuerId ||
      binding.verifierKeyId !== approvalVerifierKeyId ||
      binding.signatureAlgorithm !== approvalSignatureAlgorithm
    ) {
      throw new ApprovalError(
        "APPROVAL_KEY_INVALID",
        "Approval public key is not the fixed companion binding",
      );
    }
    return new TrustedApprovalVerifier(
      binding,
      await ContractRegistry.load(contractDirectory),
    );
  }

  verifyAndConsume(
    receipt: ApprovalReceipt,
    expected: ExpectedApprovalBinding,
    now = new Date(),
  ): void {
    if (!this.contracts.validate("approval-v1.schema.json", receipt).valid) {
      throw new ApprovalError(
        "APPROVAL_INVALID",
        "Approval receipt does not match the frozen contract",
      );
    }
    if (
      receipt.issuerId !== this.binding.issuerId ||
      receipt.approvalSessionId !== this.binding.sessionId ||
      receipt.signatureAlgorithm !== this.binding.signatureAlgorithm
    ) {
      throw new ApprovalError(
        "APPROVAL_INVALID",
        "Approval receipt issuer or signature algorithm is not trusted",
      );
    }
    assertExpectedFields(receipt, expected);

    const approvedAt = Date.parse(receipt.approvedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    if (
      !Number.isFinite(approvedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= approvedAt ||
      expiresAt - approvedAt > maxApprovalReceiptTtlMs ||
      now.getTime() < approvedAt - maxApprovalClockSkewMs ||
      now.getTime() > expiresAt + maxApprovalClockSkewMs
    ) {
      throw new ApprovalError(
        "APPROVAL_EXPIRED",
        "Approval receipt is expired or outside the allowed clock window",
      );
    }

    const signatureValid = verify(
      null,
      approvalReceiptSigningPayload(unsignedReceipt(receipt)),
      this.#publicKey,
      Buffer.from(receipt.signature, "base64url"),
    );
    if (!signatureValid) {
      throw new ApprovalError(
        "APPROVAL_INVALID",
        "Approval receipt signature is invalid",
      );
    }

    if (this.#consumedPreviewIds.has(receipt.previewId)) {
      throw new ApprovalError(
        "APPROVAL_REPLAYED",
        "Approval preview has already been consumed",
      );
    }
    this.#consumedPreviewIds.add(receipt.previewId);
  }
}
