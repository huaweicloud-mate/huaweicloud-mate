import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

import {
  approvalIssuerId,
  approvalSignatureAlgorithm,
  approvalVerifierKeyId,
} from "./constants.js";
import { ApprovalError } from "./errors.js";
import type { ApprovalSessionBinding } from "./types.js";

function parseSessionBinding(value: unknown): ApprovalSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session binding is not an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "createdAt",
    "issuerId",
    "publicKeySpki",
    "schemaVersion",
    "sessionId",
    "signatureAlgorithm",
    "verifierKeyId",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session binding has unexpected fields");
  }
  if (
    record.schemaVersion !== "huaweicloud-mate-approval-session/v1" ||
    record.issuerId !== approvalIssuerId ||
    record.verifierKeyId !== approvalVerifierKeyId ||
    record.signatureAlgorithm !== approvalSignatureAlgorithm ||
    typeof record.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(record.sessionId) ||
    typeof record.publicKeySpki !== "string" ||
    !/^[A-Za-z0-9_-]{32,2048}$/.test(record.publicKeySpki) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session binding is invalid");
  }
  return record as unknown as ApprovalSessionBinding;
}

export class ApprovalSessionKey {
  readonly binding: ApprovalSessionBinding;
  readonly #privateKey: KeyObject;
  #used = false;

  private constructor(
    binding: ApprovalSessionBinding,
    privateKey: KeyObject,
  ) {
    this.binding = binding;
    this.#privateKey = privateKey;
  }

  static create(now = new Date()): ApprovalSessionKey {
    if (!Number.isFinite(now.getTime())) {
      throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session time is invalid");
    }
    const generated = generateKeyPairSync("ed25519");
    const binding: ApprovalSessionBinding = {
      schemaVersion: "huaweicloud-mate-approval-session/v1",
      issuerId: approvalIssuerId,
      verifierKeyId: approvalVerifierKeyId,
      signatureAlgorithm: approvalSignatureAlgorithm,
      sessionId: randomBytes(24).toString("base64url"),
      publicKeySpki: generated.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      createdAt: now.toISOString(),
    };
    return new ApprovalSessionKey(binding, generated.privateKey);
  }

  signOnce(payload: Uint8Array): string {
    if (this.#used) {
      throw new ApprovalError(
        "APPROVAL_COMPANION_USED",
        "Approval companion session has already produced a result",
      );
    }
    this.#used = true;
    return sign(null, payload, this.#privateKey).toString("base64url");
  }
}

export function parseApprovalSessionBinding(
  value: unknown,
): ApprovalSessionBinding {
  return parseSessionBinding(value);
}

export function importApprovalSessionPublicKey(
  binding: ApprovalSessionBinding,
): KeyObject {
  const parsed = parseSessionBinding(binding);
  return createPublicKey({
    key: Buffer.from(parsed.publicKeySpki, "base64url"),
    format: "der",
    type: "spki",
  });
}
