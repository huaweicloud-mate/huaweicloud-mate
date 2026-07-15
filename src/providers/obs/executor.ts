import { digestAccountIdentity } from "../../approval/canonical.js";
import { CredentialStore } from "../../auth/credentials.js";
import { AuthError } from "../../auth/errors.js";
import { RouterError } from "../../router/errors.js";
import type {
  RouterCapabilityDefinition,
  RouterDispatchRequest,
  RouterDispatchResult,
  RouterExecutorAdapter,
} from "../../router/types.js";
import {
  LocalObsSessionManager,
  type LocalObsSessionBinding,
} from "./session.js";

export const localObsProviderId = "huaweicloud-obs-local";

function isObsCapability(capability: RouterCapabilityDefinition): boolean {
  return capability.executors.providerMcp?.providerId === localObsProviderId;
}

export class ObsProviderExecutor implements RouterExecutorAdapter {
  readonly executor = "provider-mcp" as const;
  private activeSession: LocalObsSessionBinding | undefined;

  constructor(
    private readonly store: CredentialStore,
    private readonly sessions: LocalObsSessionManager,
  ) {}

  async isAvailable(capability: RouterCapabilityDefinition): Promise<boolean> {
    return isObsCapability(capability);
  }

  private async session(request: RouterDispatchRequest): Promise<LocalObsSessionBinding> {
    let snapshot;
    try {
      snapshot = await this.store.read();
    } catch (error) {
      if (error instanceof AuthError) {
        throw new RouterError("AUTH_REQUIRED", "Huawei Cloud credentials are unavailable");
      }
      throw error;
    }
    if (snapshot === undefined) {
      throw new RouterError("AUTH_REQUIRED", "Huawei Cloud credentials are not configured");
    }
    if (snapshot.credentials.generation !== request.identity.credentialGeneration) {
      throw new RouterError("AUTH_SESSION_EXPIRED", "Credential generation changed before OBS execution");
    }
    if (
      digestAccountIdentity(snapshot.credentials.accountIdentity) !==
      digestAccountIdentity(request.identity.accountIdentity)
    ) {
      throw new RouterError("ACCOUNT_MISMATCH", "Stored OBS account identity changed");
    }
    if (
      this.activeSession === undefined ||
      this.activeSession.credentialGeneration !== snapshot.credentials.generation ||
      Date.parse(this.activeSession.expiresAt) <= Date.now()
    ) {
      if (this.activeSession !== undefined) {
        await this.sessions.revoke(this.activeSession);
      }
      this.activeSession = await this.sessions.create(snapshot.credentials);
    }
    if (
      digestAccountIdentity(this.activeSession.accountIdentity) !==
      digestAccountIdentity(request.identity.accountIdentity)
    ) {
      await this.sessions.revoke(this.activeSession);
      this.activeSession = undefined;
      throw new RouterError("ACCOUNT_MISMATCH", "OBS session account does not match auth identity");
    }
    return this.activeSession;
  }

  async execute(request: RouterDispatchRequest): Promise<RouterDispatchResult> {
    if (!isObsCapability(request.capability)) {
      throw new RouterError("PROVIDER_UNAVAILABLE", "OBS executor received another provider capability");
    }
    const session = await this.session(request);
    if (request.capability.capabilityId === "huaweicloud.obs.bucket.list.v1") {
      const result = await this.sessions.listBuckets(session, request.scope.region);
      return {
        result: {
          ownerAccountId: result.ownerAccountId,
          buckets: result.buckets,
        },
        effectiveAccountId: result.ownerAccountId,
        ...(request.scope.region === undefined
          ? {}
          : { effectiveRegion: request.scope.region }),
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      };
    }
    if (
      request.capability.capabilityId ===
        "huaweicloud.obs.object.text.read.v1" &&
      typeof request.arguments.bucketName === "string" &&
      typeof request.arguments.objectKey === "string" &&
      request.scope.region !== undefined
    ) {
      const result = await this.sessions.getObjectText(
        session,
        request.arguments.bucketName,
        request.arguments.objectKey,
        request.scope.region,
      );
      return {
        result: {
          bucketName: result.bucketName,
          objectKey: result.objectKey,
          region: result.region,
          contentType: result.contentType,
          contentLength: result.contentLength,
          text: result.text,
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(result.lastModified === undefined
            ? {}
            : { lastModified: result.lastModified }),
        },
        effectiveAccountId: session.accountIdentity.accountId,
        effectiveRegion: result.region,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      };
    }
    if (
      request.capability.capabilityId === "huaweicloud.obs.bucket.create.v1" &&
      typeof request.arguments.bucketName === "string" &&
      request.scope.region !== undefined
    ) {
      const result = await this.sessions.createBucket(
        session,
        request.arguments.bucketName,
        request.scope.region,
      );
      return {
        result: {
          bucketName: result.bucketName,
          region: result.region,
          location: result.location,
        },
        effectiveAccountId: session.accountIdentity.accountId,
        effectiveRegion: result.region,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      };
    }
    if (
      request.capability.capabilityId === "huaweicloud.obs.bucket.delete.v1" &&
      typeof request.arguments.bucketName === "string" &&
      request.scope.region !== undefined
    ) {
      const result = await this.sessions.deleteBucket(
        session,
        request.arguments.bucketName,
        request.scope.region,
      );
      return {
        result: {
          bucketName: result.bucketName,
          region: result.region,
          deleted: result.deleted,
        },
        effectiveAccountId: session.accountIdentity.accountId,
        effectiveRegion: result.region,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      };
    }
    throw new RouterError("CAPABILITY_NOT_FOUND", "OBS capability is not implemented");
  }
}
