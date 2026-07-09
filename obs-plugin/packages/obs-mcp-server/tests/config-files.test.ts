import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wrapper config files", () => {
  it("keeps root MetaMCP child config valid JSON", async () => {
    const config = JSON.parse(await readFile("../../.mcp.json", "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers["huaweicloud-obs"]).toBeDefined();
  });

  it("does not pass unresolved environment placeholders to MCP processes", async () => {
    const rootConfig = await readFile("../../.mcp.json", "utf8");
    const pluginConfig = await readFile("../../codex-plugin/.mcp.json", "utf8");

    expect(rootConfig).not.toContain("${");
    expect(pluginConfig).not.toContain("${");
  });

  it("keeps Codex plugin manifest valid JSON", async () => {
    const manifest = JSON.parse(await readFile("../../codex-plugin/.codex-plugin/plugin.json", "utf8")) as {
      name: string;
      mcpServers: string;
      skills: string;
    };
    expect(manifest.name).toBe("huaweicloud-obs");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.skills).toBe("./skills/");
  });

  it("keeps OpenCode config template present", async () => {
    const text = await readFile("../../.opencode/opencode.jsonc", "utf8");
    expect(text).toContain("@mentu/metamcp");
    expect(text).toContain("huaweicloud-obs-metamcp");
  });
});
