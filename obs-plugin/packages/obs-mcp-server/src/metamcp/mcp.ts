import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callMetaTool, listMetaTools } from "./tools.js";

export function createMetaMcpServer(): Server {
  const server = new Server(
    {
      name: "huaweicloud-obs-metamcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMetaTools()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callMetaTool(request.params.name, request.params.arguments);
  });

  return server;
}

export async function runMetaStdioServer(): Promise<void> {
  const server = createMetaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
