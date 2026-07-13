export type ApprovalExecutor = "provider-mcp" | "koocli";
export type ApprovalOperationKind = "read" | "write";
export type ApprovalRiskTag =
  | "destructive"
  | "privileged"
  | "cost"
  | "sensitive-read";

export interface ApprovalScope {
  readonly region?: string;
  readonly project?: string;
}

export interface ApprovalSummary {
  readonly capabilityId: string;
  readonly executor: ApprovalExecutor;
  readonly operationKind: ApprovalOperationKind;
  readonly riskTags: readonly ApprovalRiskTag[];
  readonly scope: ApprovalScope;
  readonly resources: readonly string[];
  readonly effects: readonly string[];
}

export interface ApprovalRequest {
  readonly schemaVersion: "huaweicloud-agent-approval-request/v1";
  readonly status: "confirmation_required";
  readonly previewId: string;
  readonly challenge: string;
  readonly parameterDigest: string;
  readonly summary: ApprovalSummary;
  readonly allowedIssuerIds: readonly string[];
  readonly expiresAt: string;
}

export interface ApprovalAccountIdentity {
  readonly accountId: string;
  readonly domainId?: string;
}

export interface ApprovalSigningContext {
  readonly request: ApprovalRequest;
  readonly credentialGeneration: string;
  readonly accountIdentity: ApprovalAccountIdentity;
}

export interface UnsignedApprovalReceipt {
  readonly schemaVersion: "huaweicloud-agent-approval-receipt/v1";
  readonly issuerId: string;
  readonly previewId: string;
  readonly challengeDigest: string;
  readonly parameterDigest: string;
  readonly executor: ApprovalExecutor;
  readonly credentialGeneration: string;
  readonly accountIdentityDigest: string;
  readonly scopeDigest: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly signatureAlgorithm: "ed25519";
}

export interface ApprovalReceipt extends UnsignedApprovalReceipt {
  readonly signature: string;
}

export interface ApprovalPublicKeyBinding {
  readonly schemaVersion: "huaweicloud-mate-approval-key/v1";
  readonly issuerId: string;
  readonly verifierKeyId: string;
  readonly signatureAlgorithm: "ed25519";
  readonly publicKeySpki: string;
  readonly createdAt: string;
}

export interface ExpectedApprovalBinding {
  readonly issuerId: string;
  readonly previewId: string;
  readonly challengeDigest: string;
  readonly parameterDigest: string;
  readonly executor: ApprovalExecutor;
  readonly credentialGeneration: string;
  readonly accountIdentityDigest: string;
  readonly scopeDigest: string;
}

export interface ApprovalTerminal {
  readonly interactive: boolean;
  write(message: string): void;
  readLine(prompt: string): Promise<string>;
}
