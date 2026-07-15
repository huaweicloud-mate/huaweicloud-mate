import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultAuditLogPath } from "../../src/installer/paths.js";

let dataRoot: string;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "huaweicloud-mate-mcp-data-"));
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function testEnvironment(): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    HOME: dataRoot,
    LOCALAPPDATA: dataRoot,
    XDG_DATA_HOME: dataRoot,
  };
}

describe("development stdio MCP server", () => {
  it("exposes exactly the three frozen Router tools over real stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "mcp"],
      cwd: resolve("."),
      env: testEnvironment(),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "codex-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "cloud_action_execute",
        "cloud_capabilities_search",
        "cloud_capability_describe",
      ]);
      const executeTool = tools.tools.find(
        (tool) => tool.name === "cloud_action_execute",
      );
      expect(executeTool?.inputSchema.properties).toHaveProperty("previewId");
      expect(executeTool?.inputSchema.properties).not.toHaveProperty(
        "approvalReceipt",
      );

      const search = await client.callTool({
        name: "cloud_capabilities_search",
        arguments: {
          schemaVersion: "huaweicloud-agent-search-input/v1-lite",
          query: "reference",
        },
      });
      expect(search).toMatchObject({
        structuredContent: {
          schemaVersion: "huaweicloud-agent-search-output/v1-lite",
        },
      });
      expect(search.isError).toBeUndefined();
      expect(
        (search.structuredContent?.capabilities as unknown[] | undefined)?.length,
      ).toBe(2);

      const describe = await client.callTool({
        name: "cloud_capability_describe",
        arguments: {
          schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
          capabilityId: "huaweicloud.reference.catalog.inspect.v1",
        },
      });
      expect(describe.structuredContent).toMatchObject({
        capability: {
          operationKind: "read",
          confirmationRequired: false,
        },
      });

      const execute = await client.callTool({
        name: "cloud_action_execute",
        arguments: {
          schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
          capabilityId: "huaweicloud.reference.catalog.inspect.v1",
          arguments: { query: "stdio" },
          scope: {},
        },
      });
      expect(execute.structuredContent).toMatchObject({
        status: "completed",
        result: {
          mode: "development-reference",
          items: ["local-match:stdio"],
        },
        execution: {
          executor: "provider-mcp",
          effectiveAccountId: "development-reference-no-cloud",
        },
      });

      const preview = await client.callTool({
        name: "cloud_action_execute",
        arguments: {
          schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
          capabilityId: "huaweicloud.reference.change.simulate.v1",
          arguments: { name: "approval-test" },
          scope: {},
        },
      });
      expect(preview.structuredContent).toMatchObject({
        status: "confirmation_required",
        summary: {
          capabilityId: "huaweicloud.reference.change.simulate.v1",
          operationKind: "write",
          riskTags: ["privileged"],
        },
      });
      const auditPath = defaultAuditLogPath(process.platform, dataRoot, {
        LOCALAPPDATA: dataRoot,
        XDG_DATA_HOME: dataRoot,
      });
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "dispatch-completed",
          agent: "codex",
          pluginVersion: "0.0.0-development",
        }),
        expect.objectContaining({
          event: "preview-created",
          agent: "codex",
        }),
      ]));
    } finally {
      await client.close();
    }
  });

  it("returns frozen Router errors without exposing stacks", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "mcp"],
      cwd: resolve("."),
      env: testEnvironment(),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "huaweicloud-mate-error-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "cloud_capability_describe",
        arguments: {
          schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
          capabilityId: "huaweicloud.reference.missing.v1",
        },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          schemaVersion: "huaweicloud-agent-error/v1-lite",
          status: "error",
          error: {
            code: "CAPABILITY_NOT_FOUND",
            retryable: false,
          },
        },
      });
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? text.text : "").not.toContain("at ");
    } finally {
      await client.close();
    }
  });
});
