import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  createHostInstallPlan,
  defaultHostPathRoots,
  resolveHostTemplatePath,
} from "../../src/hosts/plan.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

describe("host installation plans", () => {
  it("renders fixed Windows paths and host-native MCP shapes", async () => {
    const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
    const runtimeRoot = "C:\\Users\\example\\AppData\\Local\\hcloud-agent\\runtime";
    const binding = {
      runtimeRoot,
      versionDirectory: `${runtimeRoot}\\versions\\0.0.0-development`,
      stableLauncherPath: `${runtimeRoot}\\current\\hcloud-agent.mjs`,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    };

    const codex = createHostInstallPlan(
      registry.get("codex"),
      binding,
      "win32",
      "C:\\Users\\example",
    );
    expect(codex).toMatchObject({
      configPath:
        "C:\\Users\\example\\plugins\\huaweicloud-mate\\.mcp.json",
      mergeStrategy: "plugin-manifest",
      pluginSourcePath:
        "C:\\Users\\example\\AppData\\Local\\hcloud-agent\\runtime\\versions\\0.0.0-development\\host-assets\\codex\\plugin",
      pluginTargetPath:
        "C:\\Users\\example\\plugins\\huaweicloud-mate",
      skillTargetPath:
        "C:\\Users\\example\\plugins\\huaweicloud-mate\\skills\\huaweicloud",
      configFragment: {
        mcpServers: {
          "huaweicloud-agent": {
            command: "C:\\Program Files\\nodejs\\node.exe",
            args: [
              `${runtimeRoot}\\current\\hcloud-agent.mjs`,
              "router",
              "--stdio",
            ],
          },
        },
      },
    });

    const opencode = createHostInstallPlan(
      registry.get("opencode"),
      binding,
      "win32",
      "C:\\Users\\example",
    );
    expect(opencode).toMatchObject({
      configPath: "C:\\Users\\example\\.config\\opencode\\opencode.json",
      mergeStrategy: "json-object",
      skillSourcePath:
        "C:\\Users\\example\\AppData\\Local\\hcloud-agent\\runtime\\versions\\0.0.0-development\\skills\\canonical\\huaweicloud",
      skillTargetPath:
        "C:\\Users\\example\\.config\\opencode\\skills\\huaweicloud",
      configFragment: {
        mcp: {
          "huaweicloud-agent": {
            type: "local",
            command: [
              "C:\\Program Files\\nodejs\\node.exe",
              `${runtimeRoot}\\current\\hcloud-agent.mjs`,
              "router",
              "--stdio",
            ],
            enabled: true,
          },
        },
      },
    });

    const codearts = createHostInstallPlan(
      registry.get("codearts"),
      binding,
      "win32",
      "C:\\Users\\example",
    );
    expect(codearts.configPath).toBe(
      "C:\\Users\\example\\.codeartsdoer\\codearts_cli.jsonc",
    );
    expect(codearts.mergeStrategy).toBe("jsonc-object");
  });

  it("uses the documented POSIX user roots without platform leakage", () => {
    expect(
      defaultHostPathRoots(
        "opencode",
        "/home/example/.local/share/hcloud-agent/runtime",
        "linux",
        "/home/example",
      ),
    ).toEqual({
      userConfig: "/home/example/.config/opencode",
      userData: "/home/example/.config/opencode",
      pluginRoot:
        "/home/example/.local/share/hcloud-agent/runtime/hosts/opencode/huaweicloud-mate",
      runtimeRoot: "/home/example/.local/share/hcloud-agent/runtime",
    });
  });

  it("rejects path traversal and a launcher outside current", () => {
    const roots = defaultHostPathRoots(
      "codearts",
      "/home/example/.local/share/hcloud-agent/runtime",
      "linux",
      "/home/example",
    );
    expect(() =>
      resolveHostTemplatePath("{userConfig}/../escape", roots, "linux"),
    ).toThrow(/unsafe segment/u);

    expect(() =>
      createHostInstallPlan(
        {
          schemaVersion: "huaweicloud-agent-host-template/v1-lite",
          id: "codearts",
          displayName: "CodeArts",
          detect: { commands: ["codearts"], paths: [] },
          mcp: {
            configPath: "{userConfig}/codearts_cli.jsonc",
            entryKey: "huaweicloud-agent",
            mergeStrategy: "jsonc-object",
            launcher: { ref: "stable-runtime", args: ["router", "--stdio"] },
          },
          skills: {
            source: "canonical",
            targetPath: "{userConfig}/skills/huaweicloud",
          },
          approval: {
            mode: "bundled-trusted-companion",
            issuerId: "huaweicloud-mate.local-approval",
            verifierKeyId: "local-approval-ed25519-v1",
          },
          verify: {
            type: "config-process-skill",
            requiresTrustedApprovalProbe: true,
          },
        },
        {
          runtimeRoot: "/home/example/runtime",
          versionDirectory: "/home/example/runtime/versions/1.0.0",
          stableLauncherPath: "/tmp/hcloud-agent.mjs",
          nodePath: "/usr/bin/node",
        },
        "linux",
        "/home/example",
      ),
    ).toThrow(/stable runtime layout/u);

    expect(() =>
      createHostInstallPlan(
        {
          schemaVersion: "huaweicloud-agent-host-template/v1-lite",
          id: "opencode",
          displayName: "OpenCode",
          detect: { commands: ["opencode"], paths: [] },
          mcp: {
            configPath: "{userConfig}/opencode.json",
            entryKey: "huaweicloud-agent",
            mergeStrategy: "json-object",
            launcher: { ref: "stable-runtime", args: ["router", "--stdio"] },
          },
          skills: {
            source: "canonical",
            targetPath: "{userConfig}/skills/huaweicloud",
          },
          approval: {
            mode: "bundled-trusted-companion",
            issuerId: "huaweicloud-mate.local-approval",
            verifierKeyId: "local-approval-ed25519-v1",
          },
          verify: {
            type: "config-process-skill",
            requiresTrustedApprovalProbe: true,
          },
        },
        {
          runtimeRoot: "/home/example/runtime",
          versionDirectory: "/home/example/runtime/versions/1.0.0/nested",
          stableLauncherPath:
            "/home/example/runtime/current/hcloud-agent.mjs",
          nodePath: "/usr/bin/node",
        },
        "linux",
        "/home/example",
      ),
    ).toThrow(/stable runtime layout/u);
  });
});
