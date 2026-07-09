import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadObsEnv, type ObsEnv } from "../config/env.js";
import { OBS_API_COUNT, getOperationByToolName, obsOperations } from "../operations/inventory.js";
import type { OperationSpec } from "../operations/types.js";
import { ObsRestClient } from "../provider/client.js";
import { enforceOperationGate } from "../security/gates.js";

export function listObsTools(): Tool[] {
  if (obsOperations.length !== OBS_API_COUNT) {
    throw new Error(`OBS operation inventory must contain ${OBS_API_COUNT} operations, found ${obsOperations.length}.`);
  }

  return obsOperations.map((operation) => ({
    name: operation.toolName,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.inputSchema as Tool["inputSchema"]
  }));
}

export async function callObsTool(toolName: string, args: unknown, env: ObsEnv = loadObsEnv()): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const spec = getOperationByToolName(toolName);
  if (!spec) {
    throw new Error(`Unknown OBS tool: ${toolName}`);
  }

  const normalizedArgs = normalizeArgs(args);
  enforceOperationGate(spec, normalizedArgs, env);
  const client = new ObsRestClient(env);
  const result = await client.call(spec, normalizedArgs);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            apiName: spec.apiName,
            toolName: spec.toolName,
            risk: spec.risk,
            docsUrl: spec.docsUrl,
            result
          },
          null,
          2
        )
      }
    ]
  };
}

export function operationSummary(): Array<Pick<OperationSpec, "apiName" | "toolName" | "group" | "risk" | "docsUrl">> {
  return obsOperations.map(({ apiName, toolName, group, risk, docsUrl }) => ({
    apiName,
    toolName,
    group,
    risk,
    docsUrl
  }));
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args as Record<string, unknown>;
}
