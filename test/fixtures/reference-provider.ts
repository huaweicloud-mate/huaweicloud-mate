const digest = (character: string): string => `sha256:${character.repeat(64)}`;

export const referenceProviderDescriptor = {
  schemaVersion: "huaweicloud-agent-provider/v1-lite",
  providerId: "huaweicloud-reference-test",
  product: "reference-test",
  expectedProviderVersionRange: ">=0.1.0 <0.2.0",
  dataPlane: {
    transport: "streamable-http",
    endpoint: "https://reference.invalid/mcp",
  },
  credentialSession: {
    endpoint: "https://reference.invalid/credential-sessions",
    protocol: "huaweicloud-credential-session/v1",
    maxTtlSeconds: 900,
    routing: "opaque-route-token",
  },
  health: {
    endpoint: "https://reference.invalid/health",
  },
  capabilities: {
    path: "capabilities/reference-test.json",
    digest: digest("a"),
  },
  compatibility: {
    providerContractVersion: "huaweicloud-agent-provider-contract/v1-lite",
    credentialSessionProtocol: "huaweicloud-credential-session/v1",
    toolSchemaDigest: digest("b"),
  },
} as const;

export const referenceProviderHandshake = {
  schemaVersion: "huaweicloud-agent-provider-handshake/v1",
  status: "healthy",
  providerId: "huaweicloud-reference-test",
  providerVersion: "0.1.0",
  providerContractVersion: "huaweicloud-agent-provider-contract/v1-lite",
  credentialSessionProtocol: "huaweicloud-credential-session/v1",
  capabilityDigest: digest("a"),
  toolSchemaDigest: digest("b"),
  instanceId: "reference-provider-test-instance",
} as const;
