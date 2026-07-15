export type RouterErrorCode =
  | "CAPABILITY_NOT_FOUND"
  | "SCHEMA_MISMATCH"
  | "CONFIRMATION_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED"
  | "AUTH_REQUIRED"
  | "AUTH_SESSION_EXPIRED"
  | "ACCOUNT_MISMATCH"
  | "PERMISSION_DENIED"
  | "INVALID_SCOPE"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_INCOMPATIBLE"
  | "PROVIDER_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "OUTCOME_UNKNOWN"
  | "EXECUTOR_LOCKED"
  | "OUTPUT_REJECTED"
  | "UNKNOWN";

export class RouterError extends Error {
  constructor(
    readonly code: RouterErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RouterError";
  }
}
