import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("generated host assets", () => {
  it("derives every host skill from the single canonical source", async () => {
    const canonical = await readFile(
      resolve("dist/skills/canonical/huaweicloud/SKILL.md"),
      "utf8",
    );
    const generated = await Promise.all(
      ["codex", "claude"].map((id) =>
        readFile(
          resolve(
            `dist/host-assets/${id}/plugin/skills/huaweicloud/SKILL.md`,
          ),
          "utf8",
        ),
      ),
    );

    expect(generated).toEqual([canonical, canonical]);
    expect(canonical).toContain("Never ask the user to type a password");
    expect(canonical).not.toMatch(/AKIA[A-Z0-9]+/u);
  });

  it("keeps Codex and Claude plugin assets self-contained", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      version: string;
    };
    const codex = JSON.parse(
      await readFile(
        resolve("dist/host-assets/codex/plugin/.codex-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const claude = JSON.parse(
      await readFile(
        resolve("dist/host-assets/claude/plugin/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    for (const manifest of [codex, claude]) {
      expect(manifest).toMatchObject({
        name: packageJson.name,
        version: packageJson.version,
        skills: "./skills/",
        mcpServers: "./.mcp.json",
      });
    }

    for (const id of ["codex", "claude"]) {
      const mcp = JSON.parse(
        await readFile(
          resolve(`dist/host-assets/${id}/plugin/.mcp.json`),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(mcp).toHaveProperty("mcpServers.huaweicloud-agent");
    }
  });
});
