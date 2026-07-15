import { randomUUID } from "node:crypto";

import type { RouterIdentityContext } from "../router/types.js";
import { CredentialStore } from "./credentials.js";
import { AuthError } from "./errors.js";
import type {
  AuthMutationResult,
  AuthStatus,
  CredentialIdentityVerifier,
  CredentialPrompter,
  CredentialSessionRevoker,
  StoredCredentials,
} from "./types.js";

export interface AuthServiceOptions {
  readonly store: CredentialStore;
  readonly prompter: CredentialPrompter;
  readonly identityVerifier: CredentialIdentityVerifier;
  readonly sessionRevoker?: CredentialSessionRevoker;
  readonly now?: () => Date;
  readonly createGeneration?: () => string;
}

function validSecret(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\u0000\r\n]/u.test(value);
}

function validatedIdentity(
  value: Awaited<ReturnType<CredentialIdentityVerifier["verify"]>>,
): StoredCredentials["accountIdentity"] {
  if (
    typeof value.accountId !== "string" ||
    value.accountId.length === 0 ||
    value.accountId.length > 256 ||
    /[\u0000\r\n]/u.test(value.accountId) ||
    (value.domainId !== undefined &&
      (typeof value.domainId !== "string" ||
        value.domainId.length === 0 ||
        value.domainId.length > 256 ||
        /[\u0000\r\n]/u.test(value.domainId)))
  ) {
    throw new AuthError(
      "AUTH_IDENTITY_VERIFICATION_FAILED",
      "Huawei Cloud account identity verification returned an invalid response",
    );
  }
  return {
    accountId: value.accountId,
    ...(value.domainId === undefined ? {} : { domainId: value.domainId }),
  };
}

export class AuthService {
  private readonly now: () => Date;
  private readonly createGeneration: () => string;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createGeneration = options.createGeneration ?? randomUUID;
  }

  private async revoke(
    generation: string,
    warnings: string[],
  ): Promise<void> {
    if (this.options.sessionRevoker === undefined) {
      return;
    }
    try {
      await this.options.sessionRevoker.revokeGeneration(generation);
    } catch {
      warnings.push("Existing provider sessions could not be revoked; they remain bounded by their original expiry.");
    }
  }

  async set(): Promise<AuthMutationResult> {
    const before = await this.options.store.read();
    const accessKey = await this.options.prompter.readSecret("Huawei Cloud access key: ");
    const secretKey = await this.options.prompter.readSecret("Huawei Cloud secret key: ");
    if (!validSecret(accessKey) || !validSecret(secretKey)) {
      throw new AuthError("AUTH_INPUT_INVALID", "Access key or secret key is invalid");
    }
    const generation = this.createGeneration();
    let identity;
    try {
      identity = validatedIdentity(
        await this.options.identityVerifier.verify({ accessKey, secretKey, generation }),
      );
    } catch {
      throw new AuthError(
        "AUTH_IDENTITY_VERIFICATION_FAILED",
        "Huawei Cloud credentials could not be verified",
      );
    }
    const timestamp = this.now().toISOString();
    const credentials: StoredCredentials = {
      schemaVersion: "huaweicloud-mate-credentials/v1",
      accessKey,
      secretKey,
      generation,
      accountIdentity: identity,
      validatedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.store.replace(credentials, before?.sha256 ?? null);
    const warnings: string[] = [];
    if (before !== undefined) {
      await this.revoke(before.credentials.generation, warnings);
    }
    return {
      status: "configured",
      changed: true,
      accountIdentity: identity,
      updatedAt: timestamp,
      warnings,
    };
  }

  async status(): Promise<AuthStatus> {
    const snapshot = await this.options.store.read();
    return snapshot === undefined
      ? { configured: false }
      : {
          configured: true,
          updatedAt: snapshot.credentials.updatedAt,
          accountIdentity: snapshot.credentials.accountIdentity,
        };
  }

  async remove(): Promise<AuthMutationResult> {
    const before = await this.options.store.read();
    if (before === undefined) {
      return { status: "not-configured", changed: false, warnings: [] };
    }
    await this.options.store.remove(before.sha256);
    const warnings: string[] = [];
    await this.revoke(before.credentials.generation, warnings);
    return { status: "removed", changed: true, warnings };
  }

  async routerIdentity(): Promise<RouterIdentityContext> {
    const snapshot = await this.options.store.read();
    if (snapshot === undefined) {
      throw new AuthError("AUTH_CREDENTIALS_INVALID", "Huawei Cloud credentials are not configured");
    }
    return {
      credentialGeneration: snapshot.credentials.generation,
      accountIdentity: snapshot.credentials.accountIdentity,
    };
  }
}

export class UnavailableCredentialIdentityVerifier
  implements CredentialIdentityVerifier
{
  async verify(): Promise<never> {
    throw new AuthError(
      "AUTH_IDENTITY_VERIFICATION_FAILED",
      "Huawei Cloud identity verification provider is not available",
    );
  }
}
