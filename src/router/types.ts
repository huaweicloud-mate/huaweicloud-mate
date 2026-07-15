import type { ValidateFunction } from "ajv";

import type { RouterAuditSink } from "../audit/types.js";

import type {
  ApprovalAccountIdentity,
  ApprovalExecutor,
  ApprovalRequest,
  ApprovalReviewer,
  ApprovalRiskTag,
  ApprovalScope,
} from "../approval/types.js";

export interface RouterCapabilityDefinition {
  readonly schemaVersion: "huaweicloud-agent-capability/v1-lite";
  readonly capabilityId: string;
  readonly product: string;
  readonly summary: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly scope: {
    readonly region: "required" | "optional" | "forbidden";
    readonly project: "required" | "optional" | "forbidden";
  };
  readonly operationKind: "read" | "write";
  readonly riskTags: readonly ApprovalRiskTag[];
  readonly confirmationRequired: boolean;
  readonly executors: {
    readonly providerMcp?: {
      readonly providerId: string;
      readonly tool: string;
      readonly inputSchemaDigest: string;
    };
    readonly koocli?: {
      readonly service: string;
      readonly operation: string;
    };
  };
  readonly defaultExecutor: ApprovalExecutor;
  readonly outputPolicy: {
    readonly sensitivePaths: readonly string[];
    readonly maxBytes: number;
    readonly allowProviderText: boolean;
  };
  readonly examples?: readonly Record<string, unknown>[];
}

export interface RouterApprovalSummaryDetails {
  readonly resources: readonly string[];
  readonly effects: readonly string[];
}

export interface RouterCapabilityRegistration {
  readonly definition: RouterCapabilityDefinition;
  summarize(
    argumentsValue: Readonly<Record<string, unknown>>,
    scope: ApprovalScope,
  ): RouterApprovalSummaryDetails;
}

export interface RouterExecuteInput {
  readonly schemaVersion: "huaweicloud-agent-execute-input/v1-lite";
  readonly capabilityId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly scope: ApprovalScope;
  readonly executorPreference?: ApprovalExecutor;
  readonly previewId?: string;
}

export interface RouterIdentityContext {
  readonly credentialGeneration: string;
  readonly accountIdentity: ApprovalAccountIdentity;
}

export interface RouterDispatchRequest {
  readonly capability: RouterCapabilityDefinition;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly scope: ApprovalScope;
  readonly identity: RouterIdentityContext;
  readonly correlationId: string;
}

export interface RouterDispatchResult {
  readonly result: unknown;
  readonly effectiveAccountId: string;
  readonly effectiveProjectId?: string;
  readonly effectiveRegion?: string;
  readonly requestId?: string;
}

export interface RouterExecutorAdapter {
  readonly executor: ApprovalExecutor;
  isAvailable(capability: RouterCapabilityDefinition): Promise<boolean>;
  execute(request: RouterDispatchRequest): Promise<RouterDispatchResult>;
}

export interface RouterExecuteOutput {
  readonly schemaVersion: "huaweicloud-agent-execute-output/v1-lite";
  readonly status: "completed";
  readonly result: unknown;
  readonly execution: {
    readonly correlationId: string;
    readonly executor: ApprovalExecutor;
    readonly effectiveAccountId: string;
    readonly effectiveProjectId?: string;
    readonly effectiveRegion?: string;
    readonly requestId?: string;
    readonly durationMs: number;
  };
}

export type RouterExecuteResponse = ApprovalRequest | RouterExecuteOutput;

export interface RouterCoreOptions {
  readonly capabilities: readonly RouterCapabilityRegistration[];
  readonly adapters: readonly RouterExecutorAdapter[];
  readonly approvalReviewer?: ApprovalReviewer;
  readonly approvalManifestUrl?: URL;
  readonly identityProvider: (
    capability: RouterCapabilityDefinition,
  ) => Promise<RouterIdentityContext>;
  readonly contractDirectory?: URL;
  readonly now?: () => Date;
  readonly previewTtlMs?: number;
  readonly auditSink?: RouterAuditSink;
  readonly agentProvider?: () =>
    "codex" | "claude" | "opencode" | "codearts" | "unknown-mcp-client";
}

export interface CompiledRouterCapability {
  readonly registration: RouterCapabilityRegistration;
  readonly validateInput: ValidateFunction;
  readonly validateOutput: ValidateFunction;
}
