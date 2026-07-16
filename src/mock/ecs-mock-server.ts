#!/usr/bin/env node
/**
 * Mock ECS MCP Server — 用于本地联调
 *
 * 模拟 3 个 ECS 工具: ecs_list_servers, ecs_create_server, ecs_delete_server
 * stdio MCP 协议，Router 可直接 spawn 子进程连接
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "ecs_list_servers",
    description:
      "查询华为云ECS实例列表。支持按区域、状态过滤。典型场景：查看当前所有运行中的云服务器。输入：region(区域)、status(状态过滤)、limit(返回数量)。输出：实例列表（含ID、名称、状态、IP、规格）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string", description: "区域，默认 cn-north-4" },
        status: { type: "string", enum: ["ACTIVE", "STOPPED", "ERROR"] },
        limit: { type: "integer", default: 50 },
      },
    },
  },
  {
    name: "ecs_create_server",
    description:
      "创建华为云ECS实例。高风险操作，会产生费用。输入：region、flavor、image_id、vpc_id、subnet_id。输出：新实例ID和状态。",
    inputSchema: {
      type: "object" as const,
      properties: {
        region: { type: "string" },
        flavor: { type: "string" },
        image_id: { type: "string" },
        vpc_id: { type: "string" },
        subnet_id: { type: "string" },
        name: { type: "string" },
        count: { type: "integer", default: 1 },
      },
      required: ["region", "flavor", "image_id", "vpc_id", "subnet_id"],
    },
  },
  {
    name: "ecs_delete_server",
    description:
      "删除华为云ECS实例。高风险破坏性操作，需确认。输入：server_id。输出：删除结果。",
    inputSchema: {
      type: "object" as const,
      properties: {
        server_id: { type: "string" },
        region: { type: "string", default: "cn-north-4" },
      },
      required: ["server_id"],
    },
  },
];

async function main() {
  const server = new Server(
    { name: "ecs-mock-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "ecs_list_servers") {
      const count = Math.min(Number(args?.limit) || 3, 10);
      const servers = [];
      for (let i = 0; i < count; i++) {
        servers.push({
          id: `mock-server-${i + 1}`,
          name: `mock-ecs-${i + 1}`,
          status: args?.status || "ACTIVE",
          addresses: {
            primary: [{ addr: `192.168.1.${10 + i}`, version: "4" }],
          },
          flavor: "s6.large.2",
          created: "2026-07-01T00:00:00Z",
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ servers, count: servers.length }),
          },
        ],
      };
    }

    if (name === "ecs_create_server") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              server_id: `mock-server-${Date.now()}`,
              name: args?.name || "mock-ecs-new",
              status: "BUILD",
              created: new Date().toISOString(),
            }),
          },
        ],
      };
    }

    if (name === "ecs_delete_server") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              server_id: args?.server_id,
              status: "DELETED",
            }),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[ecs-mock] started (3 tools: list/create/delete)\n");
}

main().catch((err) => {
  process.stderr.write(`[ecs-mock] FATAL: ${err.message}\n`);
  process.exit(1);
});
