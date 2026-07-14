import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  CapabilityDescribeInput,
  CapabilitySearchInput,
} from "../catalog/types.js";
import type { DevelopmentRuntime } from "../development/runtime.js";
import { RouterError } from "../router/errors.js";
import type { RouterExecuteInput } from "../router/types.js";
import {
  actionExecuteInputSchema,
  capabilityDescribeInputSchema,
  capabilitySearchInputSchema,
} from "./schemas.js";

interface RouterErrorOutput {
  readonly schemaVersion: "huaweicloud-agent-error/v1-lite";
  readonly status: "error";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("MCP structured content must be an object");
  }
  return value as Record<string, unknown>;
}

function successResult(value: unknown) {
  const structuredContent = asStructuredContent(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

function errorOutput(error: unknown): RouterErrorOutput {
  if (error instanceof RouterError) {
    return {
      schemaVersion: "huaweicloud-agent-error/v1-lite",
      status: "error",
      error: {
        code: error.code,
        message: error.message.slice(0, 2000),
        retryable: error.retryable,
      },
    };
  }
  return {
    schemaVersion: "huaweicloud-agent-error/v1-lite",
    status: "error",
    error: {
      code: "UNKNOWN",
      message: "Router tool failed",
      retryable: false,
    },
  };
}

function failureResult(error: unknown) {
  const output = errorOutput(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: asStructuredContent(output),
  };
}

export function createRouterMcpServer(runtime: DevelopmentRuntime): McpServer {
  const server = new McpServer(
    { name: "huaweicloud-mate", version: "0.0.0-development" },
    {
      instructions:
        "Development-only Huawei Cloud Router. Use search, then describe, then execute. The bundled reference catalog never accesses Huawei Cloud or credentials. Dangerous previews require the trusted internal approval companion path; no approval tool is exposed to the Agent.",
    },
  );

  server.registerTool(
    "cloud_capabilities_search",
    {
      title: "Search Huawei Cloud capabilities",
      description:
        "Search the immutable capability catalog. This development build contains reference-only local capabilities.",
      inputSchema: capabilitySearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return successResult(runtime.catalog.search(input as CapabilitySearchInput));
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  server.registerTool(
    "cloud_capability_describe",
    {
      title: "Describe a Huawei Cloud capability",
      description:
        "Return the immutable schema, scope, risk, output policy, and executor metadata for one capability.",
      inputSchema: capabilityDescribeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return successResult(
          runtime.catalog.describe(input as CapabilityDescribeInput),
        );
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  server.registerTool(
    "cloud_action_execute",
    {
      title: "Execute a Huawei Cloud capability",
      description:
        "Execute an ordinary read or run the frozen two-stage preview/receipt protocol for risky operations.",
      inputSchema: actionExecuteInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return successResult(await runtime.router.execute(input as RouterExecuteInput));
      } catch (error) {
        return failureResult(error);
      }
    },
  );

  return server;
}
