export type AuthErrorCode =
  | "AUTH_INPUT_INVALID"
  | "AUTH_NOT_INTERACTIVE"
  | "AUTH_IDENTITY_VERIFICATION_FAILED"
  | "AUTH_CREDENTIALS_INVALID"
  | "AUTH_CREDENTIALS_CONFLICT"
  | "AUTH_CREDENTIALS_PERMISSIONS"
  | "AUTH_CREDENTIALS_WRITE_FAILED";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
