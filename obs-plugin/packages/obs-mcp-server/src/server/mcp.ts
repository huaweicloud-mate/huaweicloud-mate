import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callObsTool, listObsTools } from "./tools.js";

export function createObsMcpServer(): Server {
  const server = new Server(
    {
      name: "huaweicloud-obs-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listObsTools()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callObsTool(request.params.name, request.params.arguments);
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
  });

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createObsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
