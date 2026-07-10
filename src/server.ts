#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HwObsClient } from "./client";
import { loadConfig } from "./utils";
import { ObsTool } from "./types";

function createTools(client: HwObsClient): ObsTool[] {
  return [
    {
      name: "obs_list_buckets",
      description: "查询所有OBS桶列表。",
      isRead: true,
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () => {
        const result = await client.listBuckets();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "obs_get_bucket_location",
      description: "查询桶的区域位置。",
      isRead: true,
      inputSchema: { type: "object" as const, properties: { bucket: { type: "string" } }, required: ["bucket"] },
      handler: async (args: any) => {
        const result = await client.getBucketLocation(args.bucket);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "obs_get_bucket_metadata",
      description: "查询桶的元数据。",
      isRead: true,
      inputSchema: { type: "object" as const, properties: { bucket: { type: "string" } }, required: ["bucket"] },
      handler: async (args: any) => {
        const result = await client.getBucketMetadata(args.bucket);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "obs_list_objects",
      description: "列举桶内对象。",
      isRead: true,
      inputSchema: { type: "object" as const, properties: { bucket: { type: "string" }, prefix: { type: "string" }, max_keys: { type: "number" } }, required: ["bucket"] },
      handler: async (args: any) => {
        const result = await client.listObjects({ bucket: args.bucket, prefix: args.prefix, maxKeys: args.max_keys });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "obs_create_bucket",
      description: "创建OBS桶。",
      isRead: false,
      inputSchema: { type: "object" as const, properties: { bucket: { type: "string" }, region: { type: "string" } }, required: ["bucket"] },
      handler: async (args: any) => {
        const result = await client.createBucket({ bucket: args.bucket, region: args.region });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "obs_delete_bucket",
      description: "删除OBS桶（桶必须为空）。",
      isRead: false,
      inputSchema: { type: "object" as const, properties: { bucket: { type: "string" } }, required: ["bucket"] },
      handler: async (args: any) => {
        const result = await client.deleteBucket({ bucket: args.bucket });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
  ];
}

async function main() {
  const config = loadConfig();
  const client = new HwObsClient(config);
  const tools = createTools(client);

  const server = new Server({ name: "huaweicloud-mate", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[huaweicloud-mate] MCP server started\n");
}

main().catch((err) => {
  process.stderr.write(`[huaweicloud-mate] Fatal error: ${err.message}\n`);
  process.exit(1);
});
