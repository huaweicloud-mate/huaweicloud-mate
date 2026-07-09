/**
 * index.ts — OpenCode Plugin 入口 (v2)
 *
 * 注册 3 个内建 meta-tool：
 *   mcp_discover       → 搜索子 tool（轻量摘要，不含 inputSchema）
 *   mcp_describe_tool  → 获取单个 tool 的完整 schema
 *   mcp_call           → 转发调用到子 MCP server
 *
 * 子 MCP Server 由本插件在进程内管理（ChildManager），不再依赖外部 Gateway 进程。
 *
 * 用户接入方式 (opencode.json):
 *   { "plugin": ["iam-plugin"] }
 */

import { fileURLToPath } from "url";
import path from "path";
import { type Plugin, tool as mcpTool } from "@opencode-ai/plugin";
import { ChildManager } from "./src/child-manager.js";
import { ToolCatalog, isQueryHuaweiRelated } from "./src/catalog.js";
import { loadConfig } from "./src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HuaweiCloudPlugin: Plugin = async () => {
  const config = loadConfig();
  const catalog = new ToolCatalog();
  const childManager = new ChildManager();

  // 启动子 MCP Server 并加载工具目录
  await childManager.startAll(config.children);
  for (const serverName of childManager.listServers()) {
    try {
      const tools = await childManager.listTools(serverName);
      catalog.load(serverName, tools);
      console.error(`[iam-plugin] 已加载 "${serverName}": ${tools.length} 个 tool`);
    } catch (err) {
      console.error(`[iam-plugin] 加载 "${serverName}" 失败:`, err);
    }
  }

  console.error(`[iam-plugin] 已就绪 — ${catalog.count} 个工具已索引，3 个 meta-tool 已注册`);

  // 注册 Skills 路径（在 dist/index.js 中，skills/ 位于 ../skills）
  const skillsPath = path.resolve(__dirname, "..", "skills");

  return {
    dispose: async () => {
      await childManager.shutdownAll();
    },

    config: async (cfg) => {
      const c = cfg as any;
      if (!c.skills) c.skills = {};
      if (!c.skills.paths) c.skills.paths = [];
      if (!c.skills.paths.includes(skillsPath)) {
        c.skills.paths.push(skillsPath);
        console.error(`[iam-plugin] Skills: ${skillsPath}`);
      }
    },

    tool: {
      mcp_discover: mcpTool({
        description:
          "【华为云专用】搜索所有已连接的华为云 MCP Server 中的可用工具。仅当用户的问题涉及华为云资源、IAM、ECS、OBS、VPC 等内容时才调用此工具。返回轻量摘要列表（名称、描述、匹配分数），不包含完整参数 schema。非华为云相关问题请勿调用。",
        args: {
          query: mcpTool.schema
            .string()
            .optional()
            .describe(
              "用自然语言描述你想做什么，例如: '查询 IAM 用户列表'、'查看项目详情'、'用户组中有哪些用户'。必须与华为云相关，否则将返回空结果。"
            ),
        },
        async execute(args) {
          const query = args.query || "";
          const results = catalog.search(query);
          return {
            output: JSON.stringify(
              {
                query: query || "(全部)",
                total_tools: catalog.count,
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
          };
        },
      }),

      mcp_describe_tool: mcpTool({
        description:
          "【华为云专用】获取指定华为云工具的完整定义，包括所有参数的名称、类型、是否必填、描述。在调用 mcp_call 之前，必须先用此工具确认参数格式。仅用于华为云相关场景。",
        args: {
          server: mcpTool.schema.string().describe("mcp_discover 返回的 server 名称，例如: 'huawei-iam'"),
          tool: mcpTool.schema.string().describe("mcp_discover 返回的 tool 名称，例如: 'list_iam_users'"),
        },
        async execute(args) {
          const found = catalog.describe(args.server, args.tool);
          if (!found) {
            return {
              output: JSON.stringify(
                {
                  error: `未找到工具 "${args.tool}" (server: ${args.server})`,
                  available_servers: childManager.listServers(),
                  hint: "使用 mcp_discover 查看所有可用工具",
                },
                null,
                2
              ),
            };
          }
          return {
            output: JSON.stringify(
              {
                server: found.server,
                tool: found.tool,
                description: found.description,
                inputSchema: found.inputSchema,
              },
              null,
              2
            ),
          };
        },
      }),

      mcp_call: mcpTool({
        description:
          "【华为云专用】调用指定的华为云工具并返回结果。使用前请先用 mcp_describe_tool 确认参数格式，用 mcp_discover 查找可用工具。仅用于华为云相关场景。",
        args: {
          server: mcpTool.schema.string().describe("mcp_discover 返回的 server 名称，例如: 'huawei-iam'"),
          tool: mcpTool.schema.string().describe("mcp_discover 返回的 tool 名称，例如: 'list_iam_users'"),
          arguments: mcpTool.schema.any().describe("传递给工具的参数，参数格式请参考 mcp_describe_tool 返回的 inputSchema"),
        },
        async execute(args) {
          try {
            const result = await childManager.call(args.server, args.tool, (args.arguments || {}) as Record<string, unknown>);
            return { output: result };
          } catch (err: any) {
            return {
              output: JSON.stringify(
                { error: err.message || String(err), server: args.server, tool: args.tool },
                null,
                2
              ),
            };
          }
        },
      }),
    },
  };
};

// server 别名 — opencode 会通过此 named export 发现插件
export const server = HuaweiCloudPlugin;