import type { ApprovalExecutor, ApprovalRiskTag, ApprovalScope } from "../approval/types.js";
import type { RouterErrorCode } from "../router/errors.js";

interface AuditBase {
  readonly schemaVersion: "huaweicloud-mate-audit/v1";
  readonly timestamp: string;
  readonly agent: "codex" | "claude" | "opencode" | "codearts" | "unknown-mcp-client";
  readonly pluginVersion: string;
  readonly correlationId: string;
  readonly capabilityId: string;
  readonly product: string;
  readonly executor: ApprovalExecutor;
  readonly scope: ApprovalScope;
  readonly riskTags: readonly ApprovalRiskTag[];
  readonly parameterDigest: string;
}

export type RouterAuditEvent =
  | (AuditBase & {
      readonly event: "preview-created";
      readonly approval: "pending";
    })
  | (AuditBase & {
      readonly event: "approval-rejected";
      readonly approval: "rejected";
      readonly errorCode: "APPROVAL_INVALID";
    })
  | (AuditBase & {
      readonly event: "dispatch-started";
      readonly approval: "not-required" | "approved";
    })
  | (AuditBase & {
      readonly event: "dispatch-completed";
      readonly approval: "not-required" | "approved";
      readonly resultDigest: string;
      readonly requestId?: string;
      readonly durationMs: number;
    })
  | (AuditBase & {
      readonly event: "dispatch-failed";
      readonly approval: "not-required" | "approved";
      readonly errorCode: RouterErrorCode;
      readonly retryable: boolean;
      readonly durationMs: number;
    });

export interface RouterAuditSink {
  record(event: RouterAuditEvent): Promise<void>;
}
