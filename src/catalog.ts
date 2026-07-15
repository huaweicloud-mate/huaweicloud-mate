import { getEcsServer, getObsObjectMetadata, JsonObject, listEcsServers, listObsBuckets, listObsObjects, startEcsServers } from "./openapi";
import type { ServiceDefinition, ServiceOperation } from "./gateway";

export interface CatalogOperation extends ServiceOperation {
  inputSchema: JsonObject;
  execute(input: JsonObject): Promise<unknown>;
}

export interface CatalogService extends Omit<ServiceDefinition, "operations"> {
  operations: CatalogOperation[];
}

export const serviceCatalog: CatalogService[] = [
  {
    id: "ecs",
    title: "Elastic Cloud Server (ECS)",
    provider: "openapi",
    status: "available",
    description: "OpenAPI module. The initial catalog supports listing/details and protected batch start; import additional official operations without changing MCP tools.",
    operations: [
      {
        id: "list_servers",
        description: "List ECS server details in one project.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 1000 }, name: { type: "string" }, status: { type: "string" } } },
        execute: listEcsServers,
      },
      {
        id: "start_servers",
        description: "Start up to 1,000 ECS servers asynchronously. This operation always requires explicit user confirmation.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } } }, required: ["serverIds"] },
        execute: startEcsServers,
      },
      {
        id: "get_server",
        description: "Get the details of one ECS server.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverId: { type: "string" } }, required: ["serverId"] },
        execute: getEcsServer,
      },
    ],
  },
  {
    id: "obs",
    title: "Object Storage Service (OBS)",
    provider: "openapi",
    status: "available",
    description: "OBS REST API module. The initial catalog supports listing buckets and objects with OBS-specific request signing.",
    operations: [
      {
        id: "list_buckets",
        description: "List all OBS buckets available to the authenticated account.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" } } },
        execute: listObsBuckets,
      },
      {
        id: "list_objects",
        description: "List up to 1,000 objects in one OBS bucket.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" }, prefix: { type: "string" }, marker: { type: "string" }, delimiter: { type: "string" }, maxKeys: { type: "number", minimum: 1, maximum: 1000 } }, required: ["bucket"] },
        execute: listObsObjects,
      },
      {
        id: "get_object_metadata",
        description: "Get OBS object metadata without downloading the object content.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" }, key: { type: "string" }, versionId: { type: "string" } }, required: ["bucket", "key"] },
        execute: getObsObjectMetadata,
      },
    ],
  },
  {
    id: "koocli",
    title: "KooCLI fallback",
    provider: "koocli",
    status: "available",
    description: "Fallback for services without a dedicated OpenAPI MCP adapter. Commands run without a shell and always require user confirmation.",
    operations: [
      { id: "version", description: "Check the local KooCLI installation.", isReadOnly: true, inputSchema: { type: "object", properties: {} }, execute: async () => ({}) },
      { id: "run", description: "Run a structured KooCLI command. This always requires user confirmation.", isReadOnly: false, inputSchema: { type: "object", properties: { command: { type: "array", items: { type: "string" } }, profile: { type: "string" } }, required: ["command"] }, execute: async () => ({}) },
    ],
  },
];
