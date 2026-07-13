export const contractFileNames = [
  "approval-v1.schema.json",
  "capability-v1-lite.schema.json",
  "credential-session-v1.schema.json",
  "host-template-v1-lite.schema.json",
  "koocli-policy-v1-lite.schema.json",
  "provider-v1-lite.schema.json",
  "router-tools-v1-lite.schema.json",
] as const;

export type ContractFileName = (typeof contractFileNames)[number];

export const contractIds: Readonly<Record<ContractFileName, string>> = {
  "approval-v1.schema.json": "urn:huaweicloud:agent-plugin:approval:v1",
  "capability-v1-lite.schema.json": "urn:huaweicloud:agent-plugin:capability:v1-lite",
  "credential-session-v1.schema.json": "urn:huaweicloud:agent-plugin:credential-session:v1",
  "host-template-v1-lite.schema.json": "urn:huaweicloud:agent-plugin:host-template:v1-lite",
  "koocli-policy-v1-lite.schema.json": "urn:huaweicloud:agent-plugin:koocli-policy:v1-lite",
  "provider-v1-lite.schema.json": "urn:huaweicloud:agent-plugin:provider:v1-lite",
  "router-tools-v1-lite.schema.json": "urn:huaweicloud:agent-plugin:router-tools:v1-lite",
};
