export const approvalErrorCodes = [
  "APPROVAL_INTERACTIVE_REQUIRED",
  "APPROVAL_REQUEST_INVALID",
  "APPROVAL_REQUEST_EXPIRED",
  "APPROVAL_KEY_INVALID",
  "APPROVAL_COMPANION_USED",
  "APPROVAL_ARTIFACT_INVALID",
  "APPROVAL_PROTOCOL_INVALID",
  "APPROVAL_PROCESS_FAILED",
  "APPROVAL_PROCESS_TIMEOUT",
  "APPROVAL_UI_FAILED",
  "APPROVAL_INVALID",
  "APPROVAL_EXPIRED",
  "APPROVAL_REPLAYED",
] as const;

export type ApprovalErrorCode = (typeof approvalErrorCodes)[number];

export function isApprovalErrorCode(value: unknown): value is ApprovalErrorCode {
  return (
    typeof value === "string" &&
    approvalErrorCodes.some((code) => code === value)
  );
}

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}
