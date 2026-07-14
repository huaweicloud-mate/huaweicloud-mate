import { RouterError } from "../router/errors.js";
import type {
  RouterCapabilityDefinition,
  RouterDispatchRequest,
  RouterDispatchResult,
  RouterExecutorAdapter,
  RouterIdentityContext,
} from "../router/types.js";

export const developmentIdentity: RouterIdentityContext = {
  credentialGeneration: "00000000-0000-4000-8000-000000000001",
  accountIdentity: { accountId: "development-reference-no-cloud" },
};

function isReferenceCapability(capability: RouterCapabilityDefinition): boolean {
  return capability.executors.providerMcp?.providerId ===
    "huaweicloud-reference-test";
}

export class DevelopmentReferenceExecutor implements RouterExecutorAdapter {
  readonly executor = "provider-mcp" as const;

  async isAvailable(capability: RouterCapabilityDefinition): Promise<boolean> {
    return isReferenceCapability(capability);
  }

  async execute(request: RouterDispatchRequest): Promise<RouterDispatchResult> {
    if (!isReferenceCapability(request.capability)) {
      throw new RouterError(
        "PROVIDER_UNAVAILABLE",
        "Development reference executor received a non-reference capability",
      );
    }
    const identity = request.identity.accountIdentity.accountId;
    switch (request.capability.capabilityId) {
      case "huaweicloud.reference.catalog.inspect.v1": {
        const query = request.arguments.query;
        return {
          result: {
            mode: "development-reference",
            items:
              typeof query === "string" && query.length > 0
                ? [`local-match:${query}`]
                : ["local-reference-item"],
            notice: "Development fixture only; no Huawei Cloud request was sent",
          },
          effectiveAccountId: identity,
          ...(request.scope.region === undefined
            ? {}
            : { effectiveRegion: request.scope.region }),
          requestId: `reference-${request.correlationId}`,
        };
      }
      case "huaweicloud.reference.change.simulate.v1":
        return {
          result: {
            mode: "development-reference",
            simulated: true,
            name: request.arguments.name,
            internalTrace: `local-only:${request.correlationId}`,
          },
          effectiveAccountId: identity,
          ...(request.scope.region === undefined
            ? {}
            : { effectiveRegion: request.scope.region }),
          requestId: `reference-${request.correlationId}`,
        };
      default:
        throw new RouterError(
          "CAPABILITY_NOT_FOUND",
          `Development reference executor does not implement ${request.capability.capabilityId}`,
        );
    }
  }
}
