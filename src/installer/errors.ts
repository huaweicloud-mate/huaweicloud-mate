export const installerErrorCodes = [
  "RUNTIME_ARTIFACT_INVALID",
  "RUNTIME_VERSION_CONFLICT",
  "RUNTIME_ACTIVATION_FAILED",
  "HOST_TEMPLATE_INVALID",
  "HOST_CONFIG_INVALID",
  "HOST_CONFIG_CONFLICT",
  "HOST_CONFIG_WRITE_FAILED",
  "HOST_CONFIG_ROLLBACK_CONFLICT",
] as const;

export type InstallerErrorCode = (typeof installerErrorCodes)[number];

export class InstallerError extends Error {
  constructor(
    readonly code: InstallerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InstallerError";
  }
}
