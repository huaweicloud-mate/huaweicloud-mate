import vm from "node:vm";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { callObsTool, listObsTools } from "../server/tools.js";

const OBS_SERVER_NAME = "huaweicloud-obs";
const DEFAULT_LIMIT = 20;

export interface DiscoverArgs {
  query?: string;
  server?: string;
}

export interface DescribeToolArgs {
  server: string;
  tool: string;
}

export interface MetaCallArgs {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

export function listMetaTools(): Tool[] {
  return [
    {
      name: "mcp_discover",
      title: "Discover MCP tools",
      description:
        "Search tool catalogs across all child MCP servers and list server status. Returns lightweight results only; use mcp_describe_tool for a single tool schema.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for tool names and descriptions."
          },
          server: {
            type: "string",
            description: `Optional server filter. Use ${OBS_SERVER_NAME}.`
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "mcp_describe_tool",
      title: "Describe MCP tool",
      description: "Return the complete schema and metadata for a single child MCP tool.",
      inputSchema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: `Target server name. Use ${OBS_SERVER_NAME}.`
          },
          tool: {
            type: "string",
            description: "Tool name to describe, for example obs_create_bucket."
          }
        },
        required: ["server", "tool"],
        additionalProperties: false
      }
    },
    {
      name: "mcp_provision",
      title: "Provision MCP server",
      description: "Intent-based provisioning. For this plugin, resolves matching Huawei Cloud OBS tools from the local catalog.",
      inputSchema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "What capability you need."
          },
          context: {
            type: "string",
            description: "Additional context for resolution."
          },
          autoProvision: {
            type: "boolean",
            description: "Accepted for MetaMCP compatibility; this plugin only uses the local OBS server."
          }
        },
        required: ["intent"],
        additionalProperties: false
      }
    },
    {
      name: "mcp_call",
      title: "Call MCP tool",
      description: "Forward a tool call to a specific child MCP server.",
      inputSchema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: `Target server name. Use ${OBS_SERVER_NAME}.`
          },
          tool: {
            type: "string",
            description: "Tool name to call."
          },
          args: {
            type: "object",
            description: "Arguments to pass to the tool.",
            additionalProperties: true
          }
        },
        required: ["server", "tool"],
        additionalProperties: false
      }
    },
    {
      name: "mcp_execute",
      title: "Execute MCP workflow",
      description:
        "Run JavaScript that composes OBS tool calls. Use servers['huaweicloud-obs'].call(tool, args).",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code to execute."
          }
        },
        required: ["code"],
        additionalProperties: false
      }
    }
  ];
}

export async function callMetaTool(toolName: string, rawArgs: unknown): Promise<CallToolResult> {
  try {
    const args = normalizeArgs(rawArgs);
    if (toolName === "mcp_discover") {
      return textResult(discover(args));
    }
    if (toolName === "mcp_describe_tool") {
      return textResult(describeTool(parseDescribeToolArgs(args)));
    }
    if (toolName === "mcp_provision") {
      return textResult(provision(args));
    }
    if (toolName === "mcp_call") {
      return await callChildTool(parseMetaCallArgs(args));
    }
    if (toolName === "mcp_execute") {
      return await executeCode(args);
    }
    throw new Error(`Unknown MetaMCP tool: ${toolName}`);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

export function discover(args: DiscoverArgs): unknown {
  assertServer(args.server);
  const query = args.query?.trim();
  if (!query) {
    return [
      {
        name: OBS_SERVER_NAME,
        state: "idle",
        toolCount: listObsTools().length,
        criticality: "vital"
      }
    ];
  }

  const matches = listObsTools()
    .map((tool) => scoreTool(tool, query))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, DEFAULT_LIMIT);

  const maxScore = Math.max(1, ...matches.map((match) => match.score));
  return matches.map(({ tool, score }) => ({
    tool: tool.name,
    server: OBS_SERVER_NAME,
    description: tool.description ?? "",
    score,
    confidence: Number((score / maxScore).toFixed(2))
  }));
}

export function describeTool(args: DescribeToolArgs): unknown {
  assertServer(args.server);
  const tool = findObsTool(args.tool);
  if (!tool) {
    throw new Error(`Unknown tool ${args.tool} on ${OBS_SERVER_NAME}.`);
  }

  return {
    server: OBS_SERVER_NAME,
    tool: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}

function provision(args: Record<string, unknown>): unknown {
  const intent = typeof args.intent === "string" ? args.intent : "";
  const context = typeof args.context === "string" ? args.context : "";
  const query = [intent, context].filter(Boolean).join(" ");
  const tools = discover({ query }) as Array<Record<string, unknown>>;
  return {
    source: "local",
    tools: tools.map(({ tool, server, description, confidence }) => ({
      tool,
      server,
      description,
      confidence
    }))
  };
}

function parseDescribeToolArgs(args: Record<string, unknown>): DescribeToolArgs {
  const server = stringArg(args, "server");
  const tool = stringArg(args, "tool");
  if (!server || !tool) {
    throw new Error("mcp_describe_tool requires server and tool.");
  }
  return { server, tool };
}

function parseMetaCallArgs(args: Record<string, unknown>): MetaCallArgs {
  const server = stringArg(args, "server");
  const tool = stringArg(args, "tool");
  if (!server || !tool) {
    throw new Error("mcp_call requires server and tool.");
  }
  return {
    server,
    tool,
    args: typeof args.args === "object" && args.args !== null && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {}
  };
}

async function callChildTool(args: MetaCallArgs): Promise<CallToolResult> {
  assertServer(args.server);
  if (!args.tool) {
    throw new Error("mcp_call requires tool.");
  }
  return await callObsTool(args.tool, args.args ?? {});
}

async function executeCode(args: Record<string, unknown>): Promise<CallToolResult> {
  const code = typeof args.code === "string" ? args.code : "";
  if (!code) {
    throw new Error("mcp_execute requires code.");
  }

  const logs: string[] = [];
  const servers = {
    [OBS_SERVER_NAME]: {
      call: async (tool: string, toolArgs: Record<string, unknown> = {}) => callObsTool(tool, toolArgs)
    },
    huaweicloud_obs: {
      call: async (tool: string, toolArgs: Record<string, unknown> = {}) => callObsTool(tool, toolArgs)
    }
  };
  const context = vm.createContext({
    JSON,
    Math,
    Date,
    Array,
    Map,
    Set,
    Promise,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    console: {
      log: (...values: unknown[]) => {
        logs.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      }
    },
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30_000))),
    servers
  });

  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  const value = await Promise.race([
    script.runInContext(context, { timeout: 5_000 }) as Promise<unknown>,
    new Promise((_, reject) => setTimeout(() => reject(new Error("mcp_execute timed out.")), 120_000))
  ]);

  const text = [logs.join("\n"), typeof value === "string" ? value : JSON.stringify(value, null, 2)]
    .filter(Boolean)
    .join("\n");
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function scoreTool(tool: Tool, query: string): { tool: Tool; score: number } {
  const normalizedQuery = query.toLowerCase();
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  let score = 0;
  if (name === normalizedQuery) {
    score += 10;
  }
  if (name.includes(normalizedQuery)) {
    score += 5;
  }
  if (description.includes(normalizedQuery)) {
    score += 2;
  }

  for (const term of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (name.includes(term)) {
      score += 3;
    }
    if (description.includes(term)) {
      score += 1;
    }
  }
  return { tool, score };
}

function findObsTool(toolName: string): Tool | undefined {
  return listObsTools().find((tool) => tool.name === toolName);
}

function assertServer(server: string | undefined): void {
  if (server && server !== OBS_SERVER_NAME) {
    throw new Error(`Unknown server ${server}. Available server: ${OBS_SERVER_NAME}.`);
  }
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
