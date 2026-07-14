import type { ApprovalReviewer } from "../approval/types.js";
import { developmentCapabilityRegistrations } from "../catalog/development.js";
import { StaticCapabilityCatalog } from "../catalog/static-catalog.js";
import type { CapabilityCatalog } from "../catalog/types.js";
import {
  DevelopmentReferenceExecutor,
  developmentIdentity,
} from "../executors/development-reference.js";
import { RouterCore } from "../router/core.js";

export interface DevelopmentRuntime {
  readonly catalog: CapabilityCatalog;
  readonly router: RouterCore;
}

export interface DevelopmentRuntimeOptions {
  readonly contractDirectory?: URL;
  readonly approvalManifestUrl?: URL;
  readonly approvalReviewer?: ApprovalReviewer;
}

export async function createDevelopmentRuntime(
  options: DevelopmentRuntimeOptions = {},
): Promise<DevelopmentRuntime> {
  const catalog = await StaticCapabilityCatalog.create(
    developmentCapabilityRegistrations,
    options.contractDirectory,
  );
  const router = await RouterCore.create({
    capabilities: catalog.registrations,
    adapters: [new DevelopmentReferenceExecutor()],
    identityProvider: async () => structuredClone(developmentIdentity),
    ...(options.contractDirectory === undefined
      ? {}
      : { contractDirectory: options.contractDirectory }),
    ...(options.approvalManifestUrl === undefined
      ? {}
      : { approvalManifestUrl: options.approvalManifestUrl }),
    ...(options.approvalReviewer === undefined
      ? {}
      : { approvalReviewer: options.approvalReviewer }),
  });
  return { catalog, router };
}
