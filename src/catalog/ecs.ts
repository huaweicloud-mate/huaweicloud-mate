import type { RouterCapabilityRegistration } from "../router/types.js";

const serverIdPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const listServersInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["limit"],
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50 },
    marker: { type: "string", pattern: serverIdPattern },
  },
} as const;

const listServersOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["count", "servers", "nextMarker"],
  properties: {
    count: { type: "integer", minimum: 0, maximum: 50 },
    servers: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "status"],
        properties: {
          id: { type: "string", pattern: serverIdPattern },
          name: { type: "string", minLength: 1, maxLength: 255 },
          status: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    nextMarker: {
      anyOf: [
        { type: "string", pattern: serverIdPattern },
        { type: "null" },
      ],
    },
  },
} as const;

export const ecsCapabilityRegistrations: readonly RouterCapabilityRegistration[] = [
  {
    definition: {
      schemaVersion: "huaweicloud-agent-capability/v1-lite",
      capabilityId: "huaweicloud.ecs.server.list.v1",
      product: "ecs",
      summary: "List bounded ECS server identities and statuses through KooCLI",
      inputSchema: listServersInputSchema,
      outputSchema: listServersOutputSchema,
      scope: { region: "required", project: "required" },
      operationKind: "read",
      riskTags: ["sensitive-read"],
      confirmationRequired: true,
      executors: {
        koocli: { service: "ECS", operation: "ListServersDetails" },
      },
      defaultExecutor: "koocli",
      outputPolicy: {
        sensitivePaths: [],
        maxBytes: 128 * 1024,
        allowProviderText: false,
      },
      examples: [{ limit: 10 }],
    },
    summarize: (argumentsValue, scope) => ({
      resources: [
        `Up to ${String(argumentsValue.limit)} ECS servers in ${scope.region ?? "the selected region"}`,
      ],
      effects: [
        "Read ECS server IDs, names, and statuses",
        "Do not return addresses, metadata, security groups, or other detailed server fields",
      ],
    }),
  },
];
