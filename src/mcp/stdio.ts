import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { JsonlAuditSink } from "../audit/jsonl.js";
import { createDevelopmentRuntime } from "../development/runtime.js";
import { defaultAuditLogPath } from "../installer/paths.js";
import { createRouterMcpServer } from "./server.js";

function classifyAgent(name: string | undefined) {
  const normalized = name?.toLowerCase() ?? "";
  if (normalized.includes("codex")) return "codex" as const;
  if (normalized.includes("claude")) return "claude" as const;
  if (normalized.includes("opencode")) return "opencode" as const;
  if (normalized.includes("codearts")) return "codearts" as const;
  return "unknown-mcp-client" as const;
}

export async function runDevelopmentMcpServer(): Promise<void> {
  let server: ReturnType<typeof createRouterMcpServer> | undefined;
  const runtime = await createDevelopmentRuntime({
    auditSink: new JsonlAuditSink({ path: defaultAuditLogPath() }),
    agentProvider: () => classifyAgent(server?.server.getClientVersion()?.name),
  });
  server = createRouterMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
