import {
  ApprovalError,
  isApprovalErrorCode,
  type ApprovalErrorCode,
} from "./errors.js";
import { parseApprovalSessionBinding } from "./session-key.js";
import type {
  ApprovalReceipt,
  ApprovalSessionBinding,
  ApprovalSigningContext,
} from "./types.js";

export interface ApprovalReviewMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-review/v1";
  readonly type: "approval-review";
  readonly context: ApprovalSigningContext;
}

export interface ApprovalSessionReadyMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-session-ready/v1";
  readonly type: "approval-session-ready";
  readonly binding: ApprovalSessionBinding;
}

export interface ApprovalApprovedMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-result/v1";
  readonly type: "approval-result";
  readonly status: "approved";
  readonly approvalSessionId: string;
  readonly receipt: ApprovalReceipt;
}

export interface ApprovalRejectedMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-result/v1";
  readonly type: "approval-result";
  readonly status: "rejected";
  readonly approvalSessionId: string;
}

export interface ApprovalProcessErrorMessage {
  readonly schemaVersion: "huaweicloud-mate-approval-result/v1";
  readonly type: "approval-result";
  readonly status: "error";
  readonly approvalSessionId: string;
  readonly code: ApprovalErrorCode;
  readonly message: string;
}

export type ApprovalResultMessage =
  | ApprovalApprovedMessage
  | ApprovalRejectedMessage
  | ApprovalProcessErrorMessage;

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(record).sort().join("\n") === [...keys].sort().join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval process message has an invalid session ID",
    );
  }
  return value;
}

export function createApprovalReviewMessage(
  context: ApprovalSigningContext,
): ApprovalReviewMessage {
  return {
    schemaVersion: "huaweicloud-mate-approval-review/v1",
    type: "approval-review",
    context,
  };
}

export function parseApprovalReviewMessage(value: unknown): ApprovalReviewMessage {
  if (!isObject(value) || !hasExactKeys(value, ["context", "schemaVersion", "type"])) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval review message has unexpected fields",
    );
  }
  if (
    value.schemaVersion !== "huaweicloud-mate-approval-review/v1" ||
    value.type !== "approval-review" ||
    !isObject(value.context)
  ) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval review message is invalid",
    );
  }
  return {
    schemaVersion: "huaweicloud-mate-approval-review/v1",
    type: "approval-review",
    context: value.context as unknown as ApprovalSigningContext,
  };
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
  if (!isObject(value) || !hasExactKeys(value, ["binding", "schemaVersion", "type"])) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval session ready message has unexpected fields",
    );
  }
  if (
    value.schemaVersion !== "huaweicloud-mate-approval-session-ready/v1" ||
    value.type !== "approval-session-ready"
  ) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval session ready message is invalid",
    );
  }
  return {
    schemaVersion: "huaweicloud-mate-approval-session-ready/v1",
    type: "approval-session-ready",
    binding: parseApprovalSessionBinding(value.binding),
  };
}

export function createApprovalResultMessage(
  approvalSessionId: string,
  receipt: ApprovalReceipt | null,
): ApprovalApprovedMessage | ApprovalRejectedMessage {
  const sessionId = requireSessionId(approvalSessionId);
  return receipt === null
    ? {
        schemaVersion: "huaweicloud-mate-approval-result/v1",
        type: "approval-result",
        status: "rejected",
        approvalSessionId: sessionId,
      }
    : {
        schemaVersion: "huaweicloud-mate-approval-result/v1",
        type: "approval-result",
        status: "approved",
        approvalSessionId: sessionId,
        receipt,
      };
}

export function createApprovalProcessErrorMessage(
  approvalSessionId: string,
  error: ApprovalError,
): ApprovalProcessErrorMessage {
  return {
    schemaVersion: "huaweicloud-mate-approval-result/v1",
    type: "approval-result",
    status: "error",
    approvalSessionId: requireSessionId(approvalSessionId),
    code: error.code,
    message: error.message.slice(0, 500),
  };
}

export function parseApprovalResultMessage(value: unknown): ApprovalResultMessage {
  if (
    !isObject(value) ||
    value.schemaVersion !== "huaweicloud-mate-approval-result/v1" ||
    value.type !== "approval-result"
  ) {
    throw new ApprovalError(
      "APPROVAL_PROTOCOL_INVALID",
      "Approval result message is invalid",
    );
  }

  const approvalSessionId = requireSessionId(value.approvalSessionId);
  if (
    value.status === "approved" &&
    hasExactKeys(value, [
      "approvalSessionId",
      "receipt",
      "schemaVersion",
      "status",
      "type",
    ]) &&
    isObject(value.receipt)
  ) {
    return {
      schemaVersion: "huaweicloud-mate-approval-result/v1",
      type: "approval-result",
      status: "approved",
      approvalSessionId,
      receipt: value.receipt as unknown as ApprovalReceipt,
    };
  }
  if (
    value.status === "rejected" &&
    hasExactKeys(value, ["approvalSessionId", "schemaVersion", "status", "type"])
  ) {
    return {
      schemaVersion: "huaweicloud-mate-approval-result/v1",
      type: "approval-result",
      status: "rejected",
      approvalSessionId,
    };
  }
  if (
    value.status === "error" &&
    hasExactKeys(value, [
      "approvalSessionId",
      "code",
      "message",
      "schemaVersion",
      "status",
      "type",
    ]) &&
    isApprovalErrorCode(value.code) &&
    typeof value.message === "string" &&
    value.message.length <= 500
  ) {
    return {
      schemaVersion: "huaweicloud-mate-approval-result/v1",
      type: "approval-result",
      status: "error",
      approvalSessionId,
      code: value.code,
      message: value.message,
    };
  }
  throw new ApprovalError(
    "APPROVAL_PROTOCOL_INVALID",
    "Approval result message has unexpected fields",
  );
}
