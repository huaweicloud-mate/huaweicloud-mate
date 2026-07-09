import { describe, expect, it } from "vitest";
import { callMetaTool, describeTool, discover } from "../src/metamcp/tools.js";

describe("Huawei Cloud OBS MetaMCP wrapper tools", () => {
  it("keeps discovery results lightweight even if callers ask for schemas", () => {
    const result = discover({
      server: "huaweicloud-obs",
      query: "obs_create_bucket",
      includeSchema: true
    }) as Array<{
      tool: string;
      inputSchema?: unknown;
    }>;

    expect(result[0]?.tool).toBe("obs_create_bucket");
    expect(result[0]?.inputSchema).toBeUndefined();
  });

  it("describes a single child tool with its full input schema", () => {
    const result = describeTool({
      server: "huaweicloud-obs",
      tool: "obs_create_bucket"
    }) as {
      inputSchema: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
    };

    expect(result.inputSchema.required).toContain("bucket");
    expect(result.inputSchema.properties).toHaveProperty("body");
  });

  it("exposes mcp_describe_tool through the MCP-facing meta tool dispatcher", async () => {
    const result = await callMetaTool("mcp_describe_tool", {
      server: "huaweicloud-obs",
      tool: "obs_create_bucket"
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
    const parsed = JSON.parse(text) as {
      tool: string;
      inputSchema: {
        required?: string[];
      };
    };

    expect(parsed.tool).toBe("obs_create_bucket");
    expect(parsed.inputSchema.required).toContain("bucket");
  });
});
