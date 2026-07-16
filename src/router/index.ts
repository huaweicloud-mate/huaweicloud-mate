#!/usr/bin/env node
/**
 * huaweicloud-mate Router — 华为云 Agent 插件入口
 *
 * 5 个固定工具面向 Agent:
 *   cloud_capability_search   — 搜索能力
 *   cloud_capability_describe — 获取能力详情
 *   cloud_targets_status      — 健康检查
 *   cloud_action_plan         — 生成执行计划
 *   cloud_action_execute      — 执行操作
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Catalog } from "./catalog.js";
import { PolicyEngine } from "./policy.js";
import { CredentialBroker } from "./credential.js";
import { JsonlAuditWriter } from "./audit.js";
import { ExecutorRouter } from "./executor-router.js";
import type { RouterTool, ExecuteParams } from "./types.js";

// ─── 5 个 Router 工具定义 ─────────────────────────────────────────

function createTools(
  catalog: Catalog,
  policy: PolicyEngine,
  credential: CredentialBroker,
  executor: ExecutorRouter,
  audit: JsonlAuditWriter
): RouterTool[] {
  return [
    // ═══ 工具 1: cloud_capability_search ═══
    {
      name: "cloud_capability_search",
      description: `搜索华为云产品能力。输入自然语言描述（如"查询ECS实例列表"、"创建OBS桶"），返回匹配的能力摘要（含capabilityId、产品、操作类型、风险级别、可用执行器）。
典型场景：在操作华为云资源前，先搜索可用的能力。`,
      isRead: true,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "自然语言查询，如'列出所有ECS云服务器'",
          },
        },
        required: ["query"],
      },
      handler: async (args: any) => {
        const results = catalog.search(args.query);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      },
    },

    // ═══ 工具 2: cloud_capability_describe ═══
    {
      name: "cloud_capability_describe",
      description: `获取指定能力的完整描述，包含所有可用执行器的详细参数schema。
典型场景：Agent选定能力后，获取该能力的输入参数、输出字段、风险级别、执行器选项等详细信息。`,
      isRead: true,
      inputSchema: {
        type: "object",
        properties: {
          capabilityId: {
            type: "string",
            description: "能力ID，如 huaweicloud.ecs.server.list.v1",
          },
        },
        required: ["capabilityId"],
      },
      handler: async (args: any) => {
        const entry = catalog.get(args.capabilityId);
        if (!entry) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "CAPABILITY_NOT_FOUND",
                  message: `未找到能力: ${args.capabilityId}`,
                }),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(entry, null, 2) },
          ],
        };
      },
    },

    // ═══ 工具 3: cloud_targets_status ═══
    {
      name: "cloud_targets_status",
      description: `检查当前连接状态，包括凭证配置、执行器健康状态。在首次操作前建议先调用此工具确认连接正常。`,
      isRead: true,
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const credStatus = credential.status();
        const executorsStatus = await executor.healthCheck();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { credential: credStatus, executors: executorsStatus },
                null,
                2
              ),
            },
          ],
        };
      },
    },

    // ═══ 工具 4: cloud_action_plan ═══
    {
      name: "cloud_action_plan",
      description: `生成操作执行计划。对于高风险操作（cost/destructive级别），需要先调用此工具生成planToken，经用户确认后再调用cloud_action_execute执行。
对于read级别操作，可直接调用cloud_action_execute，无需plan。`,
      isRead: false,
      inputSchema: {
        type: "object",
        properties: {
          capabilityId: {
            type: "string",
            description: "能力ID",
          },
          executor: {
            type: "string",
            description: "执行器: mcp | koocli",
            enum: ["mcp", "koocli"],
          },
          params: {
            type: "object",
            description: "执行参数（键值对）",
          },
        },
        required: ["capabilityId", "executor", "params"],
      },
      handler: async (args: any) => {
        const plan = await policy.evaluate(args.capabilityId, args.executor, args.params);
        return {
          content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        };
      },
    },

    // ═══ 工具 5: cloud_action_execute ═══
    {
      name: "cloud_action_execute",
      description: `执行华为云操作。read级别操作可直接调用；cost/destructive级别操作需先通过cloud_action_plan获取planToken。
返回统一格式: {success, data, execution: {executor, correlationId, duration_ms}}`,
      isRead: false,
      inputSchema: {
        type: "object",
        properties: {
          planToken: {
            type: "string",
            description: "planToken（cost/destructive操作必需；read操作可省略）",
          },
          capabilityId: {
            type: "string",
            description: "能力ID（无planToken时必需）",
          },
          executor: {
            type: "string",
            description: "执行器（无planToken时必需）",
            enum: ["mcp", "koocli"],
          },
          params: {
            type: "object",
            description: "执行参数（无planToken时必需）",
          },
        },
      },
      handler: async (args: any) => {
        const result = await executeAction(args, executor, catalog, policy, credential, audit);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    },
  ];
}

async function executeAction(
  args: ExecuteParams,
  executor: ExecutorRouter,
  catalog: Catalog,
  policy: PolicyEngine,
  credential: CredentialBroker,
  audit: JsonlAuditWriter
) {
  const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();

  let capabilityId: string;
  let execType: string;
  let params: Record<string, any>;

  if (args.planToken) {
    const plan = policy.verifyAndConsume(args.planToken);
    if (!plan) {
      return { success: false, error: "INVALID_OR_EXPIRED_PLAN_TOKEN", correlationId };
    }
    capabilityId = plan.capabilityId;
    execType = plan.executor;
    params = plan.params;
  } else {
    capabilityId = args.capabilityId!;
    execType = args.executor!;
    params = args.params!;
  }

  try {
    const creds = credential.getCredentials();
    const capEntry = catalog.get(capabilityId);

    // 从 Catalog 注入执行器专属参数
    let enrichedParams = { ...params };
    if (execType === "koocli" && capEntry?.executors?.koocli) {
      enrichedParams._service = capEntry.executors.koocli.service;
      enrichedParams._operation = capEntry.executors.koocli.operation;
      if (!enrichedParams.region) {
        enrichedParams.region = creds.huaweicloud_region || "cn-north-4";
      }
    }

    // MCP 路径：从 Catalog 获取真实 tool 名
    const toolOverride = capEntry?.executors?.mcp?.tool;
    const result = await executor.execute(capabilityId, execType, enrichedParams, creds, correlationId, toolOverride);

    audit.write({
      ts: new Date().toISOString(),
      correlationId,
      capabilityId,
      executor: execType,
      risk: catalog.get(capabilityId)?.risk?.level || "unknown",
      result: result.success ? "success" : "error",
      duration_ms: Date.now() - startTime,
    });

    return result;
  } catch (err: any) {
    audit.write({
      ts: new Date().toISOString(),
      correlationId,
      capabilityId,
      executor: execType,
      risk: "unknown",
      result: "error",
      duration_ms: Date.now() - startTime,
      error: err.message,
    });

    return {
      success: false,
      error: true,
      classification: "INTERNAL_ERROR",
      message: err.message,
      correlationId,
    };
  }
}

// ─── 入口 ──────────────────────────────────────────────────────────

async function main() {
  // 后台异步安装 KooCLI (不阻塞 Router 启动)
  const { ensureKooCLI } = await import("./koocli-installer.js");
  ensureKooCLI().then((result: any) => {
    if (!result.success) {
      process.stderr.write(`[huaweicloud-mate] WARN: KooCLI not available: ${result.error}\n`);
    }
  });

  const catalog = new Catalog();
  const policy = new PolicyEngine();
  const credential = new CredentialBroker();
  const audit = new JsonlAuditWriter();
  const executor = new ExecutorRouter();

  const tools = createTools(catalog, policy, credential, executor, audit);

  const server = new Server(
    { name: "huaweicloud-mate", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[huaweicloud-mate] Router started (5 tools)\n");
}

main().catch((err) => {
  process.stderr.write(`[huaweicloud-mate] FATAL: ${err.message}\n`);
  process.exit(1);
});
