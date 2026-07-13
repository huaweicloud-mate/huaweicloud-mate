import { ApprovalError } from "./errors.js";
import { parseApprovalSessionBinding } from "./session-key.js";
import type { ApprovalSessionBinding } from "./types.js";

export interface ApprovalSessionReadyMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-session-ready/v1";
  readonly type: "approval-session-ready";
  readonly binding: ApprovalSessionBinding;
}

export function createApprovalSessionReadyMessage(
  binding: ApprovalSessionBinding,
): ApprovalSessionReadyMessage {
  return {
    schemaVersion: "huaweicloud-mate-approval-session-ready/v1",
    type: "approval-session-ready",
    binding: parseApprovalSessionBinding(binding),
  };
}

export function parseApprovalSessionReadyMessage(
  value: unknown,
): ApprovalSessionReadyMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session ready message is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\n") !==
      ["binding", "schemaVersion", "type"].join("\n") ||
    record.schemaVersion !== "huaweicloud-mate-approval-session-ready/v1" ||
    record.type !== "approval-session-ready"
  ) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval session ready message is invalid");
  }
  return {
    schemaVersion: "huaweicloud-mate-approval-session-ready/v1",
    type: "approval-session-ready",
    binding: parseApprovalSessionBinding(record.binding),
  };
}
