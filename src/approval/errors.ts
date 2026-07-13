export type ApprovalErrorCode =
  | "APPROVAL_INTERACTIVE_REQUIRED"
  | "APPROVAL_REQUEST_INVALID"
  | "APPROVAL_REQUEST_EXPIRED"
  | "APPROVAL_KEY_INVALID"
  | "APPROVAL_COMPANION_USED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED";

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}
