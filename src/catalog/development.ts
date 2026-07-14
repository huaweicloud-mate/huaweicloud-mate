import { digestCanonicalJson } from "../router/canonical.js";
import type { RouterCapabilityRegistration } from "../router/types.js";

const inspectInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", maxLength: 200 },
  },
} as const;

const simulateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

export const developmentCapabilityRegistrations: readonly RouterCapabilityRegistration[] = [
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      product: "reference",
      summary: "Inspect deterministic local reference data without cloud access",
      inputSchema: inspectInputSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "items", "notice"],
        properties: {
          mode: { const: "development-reference" },
          items: { type: "array", items: { type: "string" } },
          notice: { type: "string" },
        },
      },
      scope: { region: "optional", project: "forbidden" },
      operationKind: "read",
      riskTags: [],
      confirmationRequired: false,
      executors: {
        providerMcp: {
          providerId: "huaweicloud-reference-test",
          tool: "reference_catalog_inspect",
          inputSchemaDigest: digestCanonicalJson(inspectInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 65_536,
        allowProviderText: false,
      },
      examples: [{ query: "local" }],
    },
    summarize: () => ({
      resources: ["Local development reference catalog"],
      effects: ["Read deterministic local test data only"],
    }),
  },
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.reference.change.simulate.v1",
      product: "reference",
      summary: "Simulate a local write to exercise trusted approval",
      inputSchema: simulateInputSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "simulated", "name", "internalTrace"],
        properties: {
          mode: { const: "development-reference" },
          simulated: { const: true },
          name: { type: "string" },
          internalTrace: { type: "string" },
        },
      },
      scope: { region: "optional", project: "forbidden" },
      operationKind: "write",
      riskTags: ["privileged"],
      confirmationRequired: true,
      executors: {
        providerMcp: {
          providerId: "huaweicloud-reference-test",
          tool: "reference_change_simulate",
          inputSchemaDigest: digestCanonicalJson(simulateInputSchema),
        },
      },
      defaultExecutor: "provider-mcp",
      outputPolicy: {
        sensitivePaths: ["/internalTrace"],
        maxBytes: 65_536,
        allowProviderText: false,
      },
      examples: [{ name: "approval-demo" }],
    },
    summarize: (argumentsValue) => ({
      resources: [`local/reference/${String(argumentsValue.name)}`],
      effects: [
        "Simulate a local write for approval testing",
        "Do not access Huawei Cloud or user credentials",
      ],
    }),
  },
];
