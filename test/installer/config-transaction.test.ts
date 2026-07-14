import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyHostConfigChange,
  type ManagedHostConfig,
  rollbackHostConfigChange,
} from "../../src/installer/config-transaction.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-config-"));
  temporaryRoots.push(root);
  return root;
}

function managedConfig(
  configPath: string,
  strategy: "json-object" | "jsonc-object" | "plugin-manifest" =
    "json-object",
): ManagedHostConfig {
  const entry = {
    type: "local",
    command: [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\测试 User\\AppData\\Local\\hcloud-agent\\runtime\\current\\hcloud-agent.mjs",
      "router",
      "--stdio",
    ],
    enabled: true,
  };
  if (strategy === "plugin-manifest") {
    return {
      configPath,
      entryKey: "huaweicloud-agent",
      mergeStrategy: strategy,
      configFragment: {
        mcpServers: {
          "huaweicloud-agent": {
            command: entry.command[0],
            args: entry.command.slice(1),
          },
        },
      },
    };
  }
  return {
    configPath,
    entryKey: "huaweicloud-agent",
    mergeStrategy: strategy,
    configFragment: {
      mcp: { "huaweicloud-agent": entry },
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("host config transactions", () => {
  it("merges strict JSON, preserves unknown fields, and restores exact bytes", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "OpenCode Config", "opencode.json");
    const backupDirectory = resolve(root, "runtime", "backups");
    const original = [
      "{",
      '    "$schema": "https://opencode.ai/config.json",',
      '    "theme": "dark",',
      '    "mcp": {',
      '        "existing": {',
      '            "type": "local",',
      '            "command": ["existing"]',
      "        }",
      "    }",
      "}",
      "",
    ].join("\r\n");
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await writeFile(configPath, original, "utf8");

    const change = await applyHostConfigChange(
      managedConfig(configPath),
      backupDirectory,
    );
    const installed = await readFile(configPath, "utf8");
    const value = JSON.parse(installed) as {
      theme: string;
      mcp: Record<string, unknown>;
    };

    expect(change).toMatchObject({
      changed: true,
      createdFile: false,
      entryKey: "huaweicloud-agent",
    });
    expect(change.backupPath).toBeDefined();
    expect(await readFile(change.backupPath as string, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      expect((await lstat(change.backupPath as string)).mode & 0o777).toBe(
        0o600,
      );
      expect((await lstat(backupDirectory)).mode & 0o777).toBe(0o700);
    }
    expect(installed).toContain("\r\n");
    expect(value.theme).toBe("dark");
    expect(Object.keys(value.mcp).sort()).toEqual([
      "existing",
      "huaweicloud-agent",
    ]);

    await rollbackHostConfigChange(change);

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await pathExists(change.backupPath as string)).toBe(false);
  });

  it("preserves JSONC comments and trailing commas", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, ".codeartsdoer", "codearts_cli.jsonc");
    const original = [
      "{",
      "\t// 用户主题不能丢失",
      '\t"theme": "system",',
      '\t"mcp": {',
      "\t\t// 用户自己的 MCP",
      '\t\t"existing": { "type": "local", "command": ["existing"] },',
      "\t},",
      "}",
      "",
    ].join("\n");
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await writeFile(configPath, original, "utf8");

    const change = await applyHostConfigChange(
      managedConfig(configPath, "jsonc-object"),
      resolve(root, "backups"),
    );
    const installed = await readFile(configPath, "utf8");
    const value = parse(installed) as {
      theme: string;
      mcp: Record<string, unknown>;
    };

    expect(installed).toContain("// 用户主题不能丢失");
    expect(installed).toContain("// 用户自己的 MCP");
    expect(installed).toContain("\t\t\"huaweicloud-agent\"");
    expect(value.theme).toBe("system");
    expect(value.mcp).toHaveProperty("huaweicloud-agent");
    expect(change.installedValueHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("preserves an existing UTF-8 BOM", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "opencode.json");
    await writeFile(configPath, '\uFEFF{"theme":"dark"}\r\n', "utf8");

    await applyHostConfigChange(
      managedConfig(configPath),
      resolve(root, "backups"),
    );

    const installed = await readFile(configPath, "utf8");
    expect(installed.startsWith("\uFEFF")).toBe(true);
    expect(JSON.parse(installed.slice(1))).toHaveProperty(
      "mcp.huaweicloud-agent",
    );
  });

  it("is idempotent for the same entry and rejects a different one", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "opencode.json");
    const backupDirectory = resolve(root, "backups");
    const config = managedConfig(configPath);
    await writeFile(
      configPath,
      `${JSON.stringify(config.configFragment, null, 2)}\n`,
      "utf8",
    );

    const unchanged = await applyHostConfigChange(config, backupDirectory);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.backupPath).toBeUndefined();
    expect(await pathExists(backupDirectory)).toBe(false);

    const conflicting = JSON.parse(
      JSON.stringify(config),
    ) as ManagedHostConfig & {
      configFragment: { mcp: { "huaweicloud-agent": { enabled: boolean } } };
    };
    conflicting.configFragment.mcp["huaweicloud-agent"].enabled = false;
    await expect(
      applyHostConfigChange(conflicting, backupDirectory),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_CONFLICT" });
    expect(await pathExists(backupDirectory)).toBe(false);
  });

  it("rejects strict JSON comments, duplicate keys, and non-object roots", async () => {
    const root = await temporaryRoot();
    const backupDirectory = resolve(root, "backups");
    const cases = [
      '{\n  // comment\n  "mcp": {}\n}\n',
      '{"mcp": {}, "mcp": {}}',
      '{"mcp": []}',
    ];

    for (const [index, content] of cases.entries()) {
      const configPath = resolve(root, `invalid-${index}.json`);
      await writeFile(configPath, content, "utf8");
      await expect(
        applyHostConfigChange(managedConfig(configPath), backupDirectory),
      ).rejects.toMatchObject({ code: "HOST_CONFIG_INVALID" });
      expect(await readFile(configPath, "utf8")).toBe(content);
    }
    expect(await pathExists(backupDirectory)).toBe(false);
  });

  it("rejects invalid UTF-8 before creating a backup", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "invalid-utf8.json");
    const original = Buffer.from([0xc3, 0x28]);
    await writeFile(configPath, original);

    await expect(
      applyHostConfigChange(
        managedConfig(configPath),
        resolve(root, "backups"),
      ),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_INVALID" });
    expect(await readFile(configPath)).toEqual(original);
    expect(await pathExists(resolve(root, "backups"))).toBe(false);
  });

  it("creates and safely removes a plugin MCP manifest", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(
      root,
      "runtime",
      "hosts",
      "codex",
      "huaweicloud-mate",
      ".mcp.json",
    );
    const change = await applyHostConfigChange(
      managedConfig(configPath, "plugin-manifest"),
      resolve(root, "backups"),
    );
    const value = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };

    expect(change).toMatchObject({ changed: true, createdFile: true });
    expect(value.mcpServers).toHaveProperty("huaweicloud-agent");

    await rollbackHostConfigChange(change);
    expect(await pathExists(configPath)).toBe(false);
  });

  it("refuses rollback after the installed config changes", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "opencode.json");
    const original = '{"theme":"dark"}\n';
    await writeFile(configPath, original, "utf8");
    const change = await applyHostConfigChange(
      managedConfig(configPath),
      resolve(root, "backups"),
    );
    const userModified = `${await readFile(configPath, "utf8")}\n`;
    await writeFile(configPath, userModified, "utf8");

    await expect(rollbackHostConfigChange(change)).rejects.toMatchObject({
      code: "HOST_CONFIG_ROLLBACK_CONFLICT",
    });
    expect(await readFile(configPath, "utf8")).toBe(userModified);
    expect(await pathExists(change.backupPath as string)).toBe(true);
  });

  it("refuses rollback when the backup was changed", async () => {
    const root = await temporaryRoot();
    const configPath = resolve(root, "opencode.json");
    await writeFile(configPath, '{"theme":"dark"}\n', "utf8");
    const change = await applyHostConfigChange(
      managedConfig(configPath),
      resolve(root, "backups"),
    );
    const installed = await readFile(configPath, "utf8");
    await writeFile(change.backupPath as string, "tampered", "utf8");

    await expect(rollbackHostConfigChange(change)).rejects.toMatchObject({
      code: "HOST_CONFIG_ROLLBACK_CONFLICT",
    });
    expect(await readFile(configPath, "utf8")).toBe(installed);
  });

  it("requires absolute transaction paths", async () => {
    await expect(
      applyHostConfigChange(managedConfig("relative.json"), "backups"),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_INVALID" });
  });
});
