import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDevelopmentRuntime } from "../development/runtime.js";
import { createRouterMcpServer } from "./server.js";

export async function runDevelopmentMcpServer(): Promise<void> {
  const runtime = await createDevelopmentRuntime();
  const server = createRouterMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
