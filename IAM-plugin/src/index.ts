/**
 * index.ts — MCP Gateway 入口
 *
 * 暴露 3 个 meta-tool 给 LLM：
 *   mcp_discover      → 搜索子 tool（轻量摘要，不含 inputSchema）
 *   mcp_describe_tool → 获取单个 tool 的完整 schema
 *   mcp_call          → 转发调用到子 MCP server
 *
 * 启动:
 *   npm run dev          (开发模式, tsx)
 *   npm run build && npm start  (生产模式)
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ToolCatalog } from "./catalog.js";
import { ChildManager } from "./child-manager.js";
import { loadConfig } from "./config.js";

// ============================================================
// 初始化
// ============================================================
const config = loadConfig();
const catalog = new ToolCatalog();
const childManager = new ChildManager();

// ============================================================
// Gateway MCP Server
// ============================================================
const server = new McpServer({
  name: "iam-gateway",
  version: "0.1.0",
});

// ============================================================
// Tool 1: mcp_discover — 搜索子 tool（轻量摘要，不含 inputSchema）
// ============================================================
server.registerTool(
  "mcp_discover",
  {
    description:
      "搜索所有已连接的华为云 MCP Server 中的可用工具。返回轻量摘要列表（名称、描述、匹配分数），不包含完整参数 schema。如需查看某工具的完整参数定义，请使用 mcp_describe_tool。",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "用自然语言描述你想做什么，例如: '查询 IAM 用户列表'、'查看项目详情'、'用户组中有哪些用户'。留空则返回全部工具。"
        ),
    },
  },
  async (args) => {
    const query = args.query || "";
    const results = catalog.search(query);
    const total = catalog.count;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: query || "(全部)",
              total_tools: total,
              matched: results.length,
              results: results.map((r) => ({
                server: r.server,
                tool: r.tool,
                description: r.description,
                score: r.score,
              })),
              hint: "使用 mcp_describe_tool 查看完整参数 schema，使用 mcp_call 调用工具",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ============================================================
// Tool 2: mcp_describe_tool — 获取完整 schema
// ============================================================
server.registerTool(
  "mcp_describe_tool",
  {
    description:
      "获取指定工具的完整定义，包括所有参数的名称、类型、是否必填、描述。在调用 mcp_call 之前，必须先用此工具确认参数格式。",
    inputSchema: {
      server: z
        .string()
        .describe("mcp_discover 返回的 server 名称，例如: 'huawei-iam'"),
      tool: z
        .string()
        .describe(
          "mcp_discover 返回的 tool 名称，例如: 'list_iam_users'"
        ),
    },
  },
  async (args) => {
    const found = catalog.describe(args.server, args.tool);
    if (!found) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `未找到工具 "${args.tool}" (server: ${args.server})`,
                available_servers: childManager.listServers(),
                hint: "使用 mcp_discover 查看所有可用工具",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              server: found.server,
              tool: found.tool,
              description: found.description,
              inputSchema: found.inputSchema,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ============================================================
// Tool 3: mcp_call — 转发调用到子 server
// ============================================================
server.registerTool(
  "mcp_call",
  {
    description:
      "调用指定的华为云工具并返回结果。使用前请先用 mcp_describe_tool 确认参数格式，用 mcp_discover 查找可用工具。",
    inputSchema: {
      server: z
        .string()
        .describe("mcp_discover 返回的 server 名称，例如: 'huawei-iam'"),
      tool: z
        .string()
        .describe(
          "mcp_discover 返回的 tool 名称，例如: 'list_iam_users'"
        ),
      arguments: z
        .record(z.string(), z.unknown())
        .describe(
          "传递给工具的参数，参数格式请参考 mcp_describe_tool 返回的 inputSchema"
        ),
    },
  },
  async (args) => {
    try {
      const result = await childManager.call(args.server, args.tool, args.arguments as Record<string, unknown>);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: err.message || String(err),
                server: args.server,
                tool: args.tool,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

// ============================================================
// 启动
// ============================================================
async function main() {
  console.error("[gateway] 正在启动子 MCP Server...");
  await childManager.startAll(config.children);

  console.error("[gateway] 正在加载 tool catalog...");
  for (const serverName of childManager.listServers()) {
    try {
      const tools = await childManager.listTools(serverName);
      catalog.load(serverName, tools);
      console.error(
        `[gateway] 已加载 "${serverName}": ${tools.length} 个 tool`
      );
    } catch (err) {
      console.error(`[gateway] 加载 "${serverName}" 的 tool 失败:`, err);
    }
  }

  console.error(
    `[gateway] 已就绪 — ${catalog.count} 个工具已索引，3 个 meta-tool 已暴露`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 优雅退出
process.on("SIGINT", async () => {
  console.error("[gateway] 正在关闭...");
  await childManager.shutdownAll();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await childManager.shutdownAll();
  process.exit(0);
});

main().catch((err) => {
  console.error("[gateway] 启动失败:", err);
  process.exit(1);
});
