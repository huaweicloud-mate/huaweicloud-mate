import type { ApprovalReviewer } from "../approval/types.js";
import type { RouterAuditSink } from "../audit/types.js";
import { CredentialStore } from "../auth/credentials.js";
import { AuthError } from "../auth/errors.js";
import type { CredentialPermissionPolicy } from "../auth/permissions.js";
import { developmentCapabilityRegistrations } from "../catalog/development.js";
import { ecsCapabilityRegistrations } from "../catalog/ecs.js";
import { obsCapabilityRegistrations } from "../catalog/obs.js";
import { StaticCapabilityCatalog } from "../catalog/static-catalog.js";
import type { CapabilityCatalog } from "../catalog/types.js";
import {
  DevelopmentReferenceExecutor,
  developmentIdentity,
} from "../executors/development-reference.js";
import { CompositeProviderExecutor } from "../executors/composite-provider.js";
import {
  defaultCredentialsPath,
  defaultRuntimeRoot,
} from "../installer/paths.js";
import type { HostCommandRunner } from "../hosts/command-runner.js";
import {
  KooCliExecutorAdapter,
  type KooCliSecureInvoker,
} from "../koocli/adapter.js";
import type { KooCliArtifactBinding } from "../koocli/artifacts.js";
import { releasedKooCliArtifacts } from "../koocli/release-artifacts.js";
import {
  AuthorizedArgvKooCliInvoker,
  type KooCliArgvProcessRunner,
} from "../koocli/argv-invoker.js";
import { ObsProviderExecutor } from "../providers/obs/executor.js";
import { LocalObsSessionManager } from "../providers/obs/session.js";
import { RouterCore } from "../router/core.js";
import { RouterError } from "../router/errors.js";

export interface DevelopmentRuntime {
  readonly catalog: CapabilityCatalog;
  readonly router: RouterCore;
}

export interface DevelopmentRuntimeOptions {
  readonly contractDirectory?: URL;
  readonly approvalManifestUrl?: URL;
  readonly approvalReviewer?: ApprovalReviewer;
  readonly credentialsPath?: string;
  readonly credentialPermissions?: CredentialPermissionPolicy;
  readonly obsSessions?: LocalObsSessionManager;
  readonly runtimeRoot?: string;
  readonly koocliArtifacts?: readonly KooCliArtifactBinding[];
  readonly koocliInvoker?: KooCliSecureInvoker;
  readonly koocliRunner?: HostCommandRunner;
  readonly koocliArgvRunner?: KooCliArgvProcessRunner;
  readonly auditSink?: RouterAuditSink;
  readonly agentProvider?: () =>
    "codex" | "claude" | "opencode" | "codearts" | "unknown-mcp-client";
}

export async function createDevelopmentRuntime(
  options: DevelopmentRuntimeOptions = {},
): Promise<DevelopmentRuntime> {
  const contractDirectory =
    options.contractDirectory ??
    new URL("../contracts/schema/", import.meta.url);
  const catalog = await StaticCapabilityCatalog.create(
    [
      ...developmentCapabilityRegistrations,
      ...ecsCapabilityRegistrations,
      ...obsCapabilityRegistrations,
    ],
    contractDirectory,
  );
  const credentials = new CredentialStore({
    path: options.credentialsPath ?? defaultCredentialsPath(),
    ...(options.credentialPermissions === undefined
      ? {}
      : { permissions: options.credentialPermissions }),
  });
  const obsSessions = options.obsSessions ?? new LocalObsSessionManager();
  const koocliInvoker = options.koocliInvoker ?? new AuthorizedArgvKooCliInvoker({
    credentials,
    ...(options.koocliArgvRunner === undefined
      ? {}
      : { runner: options.koocliArgvRunner }),
  });
  const router = await RouterCore.create({
    capabilities: catalog.registrations,
    adapters: [
      new CompositeProviderExecutor([
        new DevelopmentReferenceExecutor(),
        new ObsProviderExecutor(credentials, obsSessions),
      ]),
      new KooCliExecutorAdapter({
        runtimeRoot: options.runtimeRoot ?? defaultRuntimeRoot(),
        artifacts: options.koocliArtifacts ?? releasedKooCliArtifacts,
        invoker: koocliInvoker,
        ...(options.koocliRunner === undefined
          ? {}
          : { runner: options.koocliRunner }),
      }),
    ],
    identityProvider: async (capability) => {
      if (capability.product === "reference") {
        return structuredClone(developmentIdentity);
      }
      let snapshot;
      try {
        snapshot = await credentials.read();
      } catch (error) {
        if (error instanceof AuthError) {
          throw new RouterError("AUTH_REQUIRED", "Huawei Cloud credentials are unavailable");
        }
        throw error;
      }
      if (snapshot === undefined) {
        throw new RouterError("AUTH_REQUIRED", "Huawei Cloud credentials are not configured");
      }
      return {
        credentialGeneration: snapshot.credentials.generation,
        accountIdentity: snapshot.credentials.accountIdentity,
      };
    },
    contractDirectory,
    ...(options.approvalManifestUrl === undefined
      ? {}
      : { approvalManifestUrl: options.approvalManifestUrl }),
    ...(options.approvalReviewer === undefined
      ? {}
      : { approvalReviewer: options.approvalReviewer }),
    ...(options.auditSink === undefined ? {} : { auditSink: options.auditSink }),
    ...(options.agentProvider === undefined
      ? {}
      : { agentProvider: options.agentProvider }),
  });
  return { catalog, router };
}
