import type {
  ApprovalExecutor,
  ApprovalRiskTag,
} from "../approval/types.js";
import type {
  RouterCapabilityDefinition,
  RouterCapabilityRegistration,
} from "../router/types.js";

export interface CapabilitySearchInput {
  readonly schemaVersion: "huaweicloud-agent-search-input/v1-lite";
  readonly query: string;
  readonly product?: string;
  readonly operationKind?: "read" | "write";
  readonly riskTags?: readonly ApprovalRiskTag[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CapabilitySearchItem {
  readonly capabilityId: string;
  readonly product: string;
  readonly summary: string;
  readonly operationKind: "read" | "write";
  readonly riskTags: readonly ApprovalRiskTag[];
  readonly executors: readonly ApprovalExecutor[];
  readonly defaultExecutor: ApprovalExecutor;
}

export interface CapabilitySearchOutput {
  readonly schemaVersion: "huaweicloud-agent-search-output/v1-lite";
  readonly capabilities: readonly CapabilitySearchItem[];
  readonly nextCursor?: string;
}

export interface CapabilityDescribeInput {
  readonly schemaVersion: "huaweicloud-agent-describe-input/v1-lite";
  readonly capabilityId: string;
}

export interface CapabilityDescribeOutput {
  readonly schemaVersion: "huaweicloud-agent-describe-output/v1-lite";
  readonly capability: RouterCapabilityDefinition;
}

export interface CapabilityCatalog {
  readonly registrations: readonly RouterCapabilityRegistration[];
  search(input: CapabilitySearchInput): CapabilitySearchOutput;
  describe(input: CapabilityDescribeInput): CapabilityDescribeOutput;
}
