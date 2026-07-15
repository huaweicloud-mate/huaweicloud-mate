import { deleteObsBucket, deleteObsObject, getEcsJob, getEcsServer, getObsBucketLocation, getObsBucketMetadata, getObsObjectMetadata, JsonObject, listEcsServers, listObsBuckets, listObsObjects, rebootEcsServers, startEcsServers, stopEcsServers } from "./openapi";
import type { ServiceDefinition, ServiceOperation } from "./gateway";

export interface CatalogOperation extends ServiceOperation {
  inputSchema: JsonObject;
  sourceUrl?: string;
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
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=ListServersDetails",
        execute: listEcsServers,
      },
      {
        id: "start_servers",
        description: "Start up to 1,000 ECS servers asynchronously. This operation always requires explicit user confirmation.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } } }, required: ["serverIds"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=BatchStartServers",
        execute: startEcsServers,
      },
      {
        id: "get_server",
        description: "Get the details of one ECS server.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverId: { type: "string" } }, required: ["serverId"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=ShowServer",
        execute: getEcsServer,
      },
      {
        id: "get_job",
        description: "Get the status of an asynchronous ECS job returned by lifecycle operations.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, jobId: { type: "string" } }, required: ["jobId"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=ShowJob",
        execute: getEcsJob,
      },
      {
        id: "stop_servers",
        description: "Stop up to 1,000 ECS servers asynchronously. The default type is SOFT; this operation always requires explicit user confirmation.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } }, type: { type: "string", enum: ["SOFT", "HARD"] } }, required: ["serverIds"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=BatchStopServers",
        execute: stopEcsServers,
      },
      {
        id: "reboot_servers",
        description: "Reboot up to 1,000 ECS servers asynchronously. Select SOFT or HARD and explicitly confirm before execution.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, projectId: { type: "string" }, serverIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } }, type: { type: "string", enum: ["SOFT", "HARD"] } }, required: ["serverIds", "type"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=BatchRebootServers",
        execute: rebootEcsServers,
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
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=ListBuckets",
        execute: listObsBuckets,
      },
      {
        id: "get_bucket_metadata",
        description: "Get OBS bucket metadata without modifying the bucket.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" } }, required: ["bucket"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=GetBucketMetadata",
        execute: getObsBucketMetadata,
      },
      {
        id: "get_bucket_location",
        description: "Get the region where one OBS bucket resides.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" } }, required: ["bucket"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=GetBucketLocation",
        execute: getObsBucketLocation,
      },
      {
        id: "delete_bucket",
        description: "Delete one empty OBS bucket. This operation always requires explicit user confirmation.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" } }, required: ["bucket"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=DeleteBucket",
        execute: deleteObsBucket,
      },
      {
        id: "list_objects",
        description: "List up to 1,000 objects in one OBS bucket.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" }, prefix: { type: "string" }, marker: { type: "string" }, delimiter: { type: "string" }, maxKeys: { type: "number", minimum: 1, maximum: 1000 } }, required: ["bucket"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=ListObjects",
        execute: listObsObjects,
      },
      {
        id: "get_object_metadata",
        description: "Get OBS object metadata without downloading the object content.",
        isReadOnly: true,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" }, key: { type: "string" }, versionId: { type: "string" } }, required: ["bucket", "key"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=HeadObject",
        execute: getObsObjectMetadata,
      },
      {
        id: "delete_object",
        description: "Delete one OBS object or one object version. This operation always requires explicit user confirmation.",
        isReadOnly: false,
        inputSchema: { type: "object", properties: { region: { type: "string" }, bucket: { type: "string" }, key: { type: "string" }, versionId: { type: "string" } }, required: ["bucket", "key"] },
        sourceUrl: "https://console.huaweicloud.com/apiexplorer/#/openapi/OBS/doc?api=DeleteObject",
        execute: deleteObsObject,
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
