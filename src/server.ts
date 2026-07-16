#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { call, discover, provision } from "./gateway";
import { runInstaller, runLocalSetupServer } from "./installer";
import { clearStoredCredentials, configureStoredCredentials } from "./credentials";

const tools = [
  { name: "huaweicloud_discover", description: "Search Huawei Cloud capability modules without loading every service schema.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "huaweicloud_provision", description: "Get one service operation catalog after discovery.", inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
  { name: "huaweicloud_call", description: "Call one Huawei Cloud operation. Mutating operations require a confirmation token after explicit user confirmation.", inputSchema: { type: "object", properties: { service: { type: "string" }, operation: { type: "string" }, input: { type: "object" }, confirmationToken: { type: "string" } }, required: ["service", "operation", "input"] } },
];

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

async function startMcp(): Promise<void> {
  const server = new Server({ name: "huaweicloud-mate", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asObject(request.params.arguments ?? {});
    let result: unknown;
    if (request.params.name === "huaweicloud_discover") result = discover(typeof args.query === "string" ? args.query : undefined);
    else if (request.params.name === "huaweicloud_provision") {
      if (typeof args.service !== "string") throw new Error("service is required.");
      result = await provision(args.service);
    } else if (request.params.name === "huaweicloud_call") {
      if (typeof args.service !== "string" || typeof args.operation !== "string") throw new Error("service and operation are required.");
      result = await call(args.service, args.operation, args.input, typeof args.confirmationToken === "string" ? args.confirmationToken : undefined);
    } else throw new Error(`Unknown tool: ${request.params.name}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write("[huaweicloud-mate] Dynamic MCP gateway started.\n");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "install") return runInstaller(args);
  if (command === "setup") {
    await runLocalSetupServer(args);
    return;
  }
  if (command === "configure") return configureStoredCredentials();
  if (command === "clear-credentials") return clearStoredCredentials();
  if (command === "--help" || command === "-h") {
    process.stdout.write("huaweicloud-mate [install --agent auto|codex|claude-code|opencode] | configure | clear-credentials\n");
    process.stdout.write("Without a command, starts the stdio MCP gateway.\n");
    return;
  }
  return startMcp();
}

main().catch((error: unknown) => {
  process.stderr.write(`[huaweicloud-mate] Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
