import type { ApprovalAccountIdentity } from "../approval/types.js";

export interface CredentialSecretInput {
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface StoredCredentials extends CredentialSecretInput {
  readonly schemaVersion: "huaweicloud-mate-credentials/v1";
  readonly generation: string;
  readonly accountIdentity: ApprovalAccountIdentity;
  readonly validatedAt: string;
  readonly updatedAt: string;
}

export interface CredentialSnapshot {
  readonly credentials: StoredCredentials;
  readonly sha256: string;
}

export type AuthStatus =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly updatedAt: string;
      readonly accountIdentity: ApprovalAccountIdentity;
    };

export interface CredentialPrompter {
  readSecret(prompt: string): Promise<string>;
}

export interface CredentialIdentityVerifier {
  verify(
    credentials: CredentialSecretInput & { readonly generation: string },
  ): Promise<ApprovalAccountIdentity>;
}

export interface CredentialSessionRevoker {
  revokeGeneration(generation: string): Promise<void>;
}

export interface AuthMutationResult {
  readonly status: "configured" | "removed" | "not-configured";
  readonly changed: boolean;
  readonly accountIdentity?: ApprovalAccountIdentity;
  readonly updatedAt?: string;
  readonly warnings: readonly string[];
}
