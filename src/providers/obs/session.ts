import { randomBytes, timingSafeEqual } from "node:crypto";

import type { ApprovalAccountIdentity } from "../../approval/types.js";
import type {
  CredentialIdentityVerifier,
  CredentialSessionRevoker,
  StoredCredentials,
} from "../../auth/types.js";
import { RouterError } from "../../router/errors.js";
import {
  ObsClient,
  type ObsCreateBucketResult,
  type ObsDeleteBucketResult,
  type ObsGetObjectTextResult,
  type ObsListBucketsResult,
} from "./client.js";

const maxSessionTtlSeconds = 900;

interface LocalObsSession {
  readonly sessionId: string;
  readonly routeToken: string;
  readonly providerInstanceId: string;
  readonly credentialGeneration: string;
  readonly expiresAt: string;
  readonly accountIdentity: ApprovalAccountIdentity;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface LocalObsSessionBinding {
  readonly sessionId: string;
  readonly routeToken: string;
  readonly providerInstanceId: string;
  readonly credentialGeneration: string;
  readonly expiresAt: string;
  readonly accountIdentity: ApprovalAccountIdentity;
}

export interface LocalObsSessionManagerOptions {
  readonly client?: Pick<ObsClient, "listBuckets"> &
    Partial<Pick<ObsClient, "createBucket" | "deleteBucket" | "getObjectText">>;
  readonly now?: () => Date;
  readonly providerInstanceId?: string;
}

function opaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function sameOpaque(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class LocalObsSessionManager implements CredentialSessionRevoker {
  private readonly client: Pick<ObsClient, "listBuckets"> &
    Partial<Pick<ObsClient, "createBucket" | "deleteBucket" | "getObjectText">>;
  private readonly now: () => Date;
  private readonly providerInstanceId: string;
  private readonly sessions = new Map<string, LocalObsSession>();

  constructor(options: LocalObsSessionManagerOptions = {}) {
    this.client = options.client ?? new ObsClient();
    this.now = options.now ?? (() => new Date());
    this.providerInstanceId = options.providerInstanceId ?? opaqueId();
  }

  private purgeExpired(): void {
    const now = this.now().getTime();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(id);
      }
    }
  }

  async create(
    credentials: Pick<StoredCredentials, "accessKey" | "secretKey" | "generation">,
    requestedTtlSeconds = maxSessionTtlSeconds,
  ): Promise<LocalObsSessionBinding> {
    if (
      !Number.isSafeInteger(requestedTtlSeconds) ||
      requestedTtlSeconds < 1 ||
      requestedTtlSeconds > maxSessionTtlSeconds
    ) {
      throw new RouterError("VALIDATION_FAILED", "OBS credential session TTL is invalid");
    }
    this.purgeExpired();
    const verified = await this.client.listBuckets({
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
    });
    const accountIdentity = {
      accountId: verified.ownerAccountId,
      domainId: verified.ownerAccountId,
    } as const;
    const session: LocalObsSession = {
      sessionId: opaqueId(),
      routeToken: opaqueId(),
      providerInstanceId: this.providerInstanceId,
      credentialGeneration: credentials.generation,
      expiresAt: new Date(
        this.now().getTime() + requestedTtlSeconds * 1000,
      ).toISOString(),
      accountIdentity,
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
    };
    this.sessions.set(session.sessionId, session);
    return {
      sessionId: session.sessionId,
      routeToken: session.routeToken,
      providerInstanceId: session.providerInstanceId,
      credentialGeneration: session.credentialGeneration,
      expiresAt: session.expiresAt,
      accountIdentity: session.accountIdentity,
    };
  }

  private session(binding: LocalObsSessionBinding): LocalObsSession {
    this.purgeExpired();
    const session = this.sessions.get(binding.sessionId);
    if (
      session === undefined ||
      !sameOpaque(session.routeToken, binding.routeToken) ||
      session.providerInstanceId !== binding.providerInstanceId ||
      session.credentialGeneration !== binding.credentialGeneration
    ) {
      throw new RouterError("AUTH_SESSION_EXPIRED", "OBS credential session is unavailable");
    }
    return session;
  }

  async listBuckets(
    binding: LocalObsSessionBinding,
    region?: string,
  ): Promise<ObsListBucketsResult> {
    const session = this.session(binding);
    const result = await this.client.listBuckets({
      accessKey: session.accessKey,
      secretKey: session.secretKey,
      ...(region === undefined ? {} : { region }),
    });
    if (result.ownerAccountId !== session.accountIdentity.accountId) {
      this.sessions.delete(session.sessionId);
      throw new RouterError("ACCOUNT_MISMATCH", "OBS returned a different account identity");
    }
    return result;
  }

  async createBucket(
    binding: LocalObsSessionBinding,
    bucketName: string,
    region: string,
  ): Promise<ObsCreateBucketResult> {
    const session = this.session(binding);
    if (this.client.createBucket === undefined) {
      throw new RouterError("PROVIDER_UNAVAILABLE", "OBS bucket creation is unavailable");
    }
    return await this.client.createBucket({
      accessKey: session.accessKey,
      secretKey: session.secretKey,
      bucketName,
      region,
    });
  }

  async deleteBucket(
    binding: LocalObsSessionBinding,
    bucketName: string,
    region: string,
  ): Promise<ObsDeleteBucketResult> {
    const session = this.session(binding);
    if (this.client.deleteBucket === undefined) {
      throw new RouterError("PROVIDER_UNAVAILABLE", "OBS bucket deletion is unavailable");
    }
    return await this.client.deleteBucket({
      accessKey: session.accessKey,
      secretKey: session.secretKey,
      bucketName,
      region,
    });
  }

  async getObjectText(
    binding: LocalObsSessionBinding,
    bucketName: string,
    objectKey: string,
    region: string,
  ): Promise<ObsGetObjectTextResult> {
    const session = this.session(binding);
    if (this.client.getObjectText === undefined) {
      throw new RouterError("PROVIDER_UNAVAILABLE", "OBS object reading is unavailable");
    }
    return await this.client.getObjectText({
      accessKey: session.accessKey,
      secretKey: session.secretKey,
      bucketName,
      objectKey,
      region,
    });
  }

  async revoke(binding: LocalObsSessionBinding): Promise<void> {
    const session = this.sessions.get(binding.sessionId);
    if (session !== undefined && sameOpaque(session.routeToken, binding.routeToken)) {
      this.sessions.delete(binding.sessionId);
    }
  }

  async revokeGeneration(generation: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.credentialGeneration === generation) {
        this.sessions.delete(id);
      }
    }
  }
}

export class ObsCredentialIdentityVerifier implements CredentialIdentityVerifier {
  constructor(private readonly sessions: LocalObsSessionManager) {}

  async verify(credentials: {
    readonly accessKey: string;
    readonly secretKey: string;
    readonly generation: string;
  }): Promise<ApprovalAccountIdentity> {
    const session = await this.sessions.create(credentials);
    try {
      return session.accountIdentity;
    } finally {
      await this.sessions.revoke(session);
    }
  }
}
