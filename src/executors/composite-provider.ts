import { RouterError } from "../router/errors.js";
import type {
  RouterCapabilityDefinition,
  RouterDispatchRequest,
  RouterDispatchResult,
  RouterExecutorAdapter,
} from "../router/types.js";

export class CompositeProviderExecutor implements RouterExecutorAdapter {
  readonly executor = "provider-mcp" as const;

  constructor(private readonly delegates: readonly RouterExecutorAdapter[]) {
    if (delegates.some((delegate) => delegate.executor !== "provider-mcp")) {
      throw new RouterError("SCHEMA_MISMATCH", "Composite provider contains another executor type");
    }
  }

  async isAvailable(capability: RouterCapabilityDefinition): Promise<boolean> {
    for (const delegate of this.delegates) {
      if (await delegate.isAvailable(capability)) {
        return true;
      }
    }
    return false;
  }

  async execute(request: RouterDispatchRequest): Promise<RouterDispatchResult> {
    for (const delegate of this.delegates) {
      if (await delegate.isAvailable(request.capability)) {
        return delegate.execute(request);
      }
    }
    throw new RouterError("PROVIDER_UNAVAILABLE", "No provider implements this capability", true);
  }
}
