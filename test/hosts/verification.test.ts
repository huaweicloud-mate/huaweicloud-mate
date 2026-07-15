import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeCodexPluginRunner } from "../fixtures/codex-plugin-runner.js";
import { FakeClaudeLifecycleRunner } from "../fixtures/claude-lifecycle-runner.js";
import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import type { HostId } from "../../src/hosts/types.js";
import {
  createInitialHostVerificationHook,
  verifyInitialInstallHosts,
} from "../../src/hosts/verification.js";
import { hasExactRouterToolSet } from "../../src/hosts/router-process-verification.js";
import { runInitialInstallTransaction } from "../../src/installer/initial-install.js";
import { readInstallState } from "../../src/installer/install-state.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-verification-"));
  temporaryRoots.push(root);
  return root;
}

async function fixture(ids: readonly HostId[]) {
  const root = await temporaryRoot();
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const plans = ids.map((id) =>
    createHostInstallPlan(
      registry.get(id),
      runtime,
      platform,
      resolve(root, "home"),
    ),
  );
  const codexRunner = new FakeCodexPluginRunner(root);
  return { root, runtime, plans, codexRunner };
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

function assetTarget(
  plan: Awaited<ReturnType<typeof fixture>>["plans"][number],
): string {
  return plan.mergeStrategy === "plugin-manifest"
    ? plan.pluginTargetPath as string
    : plan.skillTargetPath;
}

function result(stdout: string): HostCommandResult {
  return { code: 0, signal: null, stdout, stderr: "" };
}

function successfulRunner(
  runtime: Awaited<ReturnType<typeof fixture>>["runtime"],
  root: string,
  missingCommands: readonly string[] = ["codearts"],
): HostCommandRunner {
  const commandPaths = new Map(
    ["codex", "claude", "opencode", "codearts"].map((command) => [
      command,
      resolve(root, "fake-bin", `${command}.exe`),
    ]),
  );
  return {
    async resolveCommand(command) {
      return missingCommands.includes(command)
        ? undefined
        : commandPaths.get(command);
    },
    async run(executablePath, args) {
      if (executablePath === runtime.nodePath) {
        expect(args).toEqual([runtime.stableLauncherPath, "version"]);
        return result(`${runtime.pluginVersion}\n`);
      }
      const command = basename(executablePath, ".exe");
      const invocation = args.join(" ");
      if (command === "codex" && invocation === "plugin list --json") {
        return result(`${JSON.stringify({
          installed: [{
            pluginId: "huaweicloud-mate@personal",
            name: "huaweicloud-mate",
            marketplaceName: "personal",
            version: "local",
            installed: true,
            enabled: true,
            source: { source: "local" },
            installPolicy: "AVAILABLE",
            authPolicy: "ON_INSTALL",
          }],
          available: [],
        })}\n`);
      }
      if (command === "claude" && invocation === "plugin list --json") {
        return result(`${JSON.stringify([{ id: "huaweicloud-mate@local" }])}\n`);
      }
      if (command === "opencode" && invocation === "mcp list") {
        return result("huaweicloud-agent connected\n");
      }
      if (command === "opencode" && invocation === "debug skill") {
        return result("huaweicloud\n");
      }
      throw new Error(`Unexpected command: ${command} ${invocation}`);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("initial host verification", () => {
  it("verifies four-host discovery before the install-state commit", async () => {
    const { root, runtime, plans, codexRunner } = await fixture([
      "codex",
      "claude",
      "opencode",
      "codearts",
    ]);
    const approvalProbe = vi.fn(async () => undefined);
    const runner = successfulRunner(runtime, root);
    const claudePlan = plans.find((plan) => plan.id === "claude");
    if (claudePlan?.pluginTargetPath === undefined) {
      throw new Error("Claude plan is missing");
    }
    const claudeRunner = new FakeClaudeLifecycleRunner(
      root,
      dirname(claudePlan.pluginTargetPath),
      runtime.pluginVersion,
      runner,
    );
    let report: Awaited<ReturnType<typeof verifyInitialInstallHosts>> | undefined;

    const installed = await runInitialInstallTransaction({
      runtime,
      plans,
      codexRunner,
      claudeRunner,
      verify: async (context) => {
        expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
        report = await verifyInitialInstallHosts(context, {
          runner: claudeRunner,
          approvalProbe,
        });
      },
    });

    expect(approvalProbe).toHaveBeenCalledOnce();
    expect(report).toEqual({
      hosts: [
        expect.objectContaining({
          id: "claude",
          checks: expect.arrayContaining(["plugin-registration"]),
        }),
        expect.objectContaining({
          id: "codearts",
          checks: expect.arrayContaining(["config-registration", "mcp-process"]),
        }),
        expect.objectContaining({
          id: "codex",
          checks: expect.arrayContaining(["plugin-registration"]),
        }),
        expect.objectContaining({
          id: "opencode",
          checks: expect.arrayContaining(["mcp-registration"]),
        }),
      ],
      routerProcessProbe: "passed",
      approvalProbe: "passed",
    });
    expect(await readInstallState(runtime.runtimeRoot)).toMatchObject({
      state: installed.state,
    });
  }, 15_000);

  it("rolls back when a detected plugin is not registered", async () => {
    const { root, runtime, plans, codexRunner } = await fixture(["codex"]);
    const baseRunner = successfulRunner(runtime, root, []);
    const runner: HostCommandRunner = {
      resolveCommand: (command) => baseRunner.resolveCommand(command),
      run: async (executablePath, args, timeoutMs) =>
        basename(executablePath, ".exe") === "codex"
          ? result(`${JSON.stringify({ installed: [], available: [] })}\n`)
          : baseRunner.run(executablePath, args, timeoutMs),
    };

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        codexRunner,
        verify: createInitialHostVerificationHook({
          runner,
          approvalProbe: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({ code: "HOST_REGISTRATION_MISSING" });

    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  });

  it("rolls back when neither a host command nor a detection path exists", async () => {
    const { root, runtime, plans, codexRunner } = await fixture(["codex"]);

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        codexRunner,
        verify: createInitialHostVerificationHook({
          runner: successfulRunner(runtime, root, ["codex"]),
          approvalProbe: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({ code: "HOST_DISCOVERY_FAILED" });

    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
  });

  it("rolls back when the click-only approval probe fails", async () => {
    const { root, runtime, plans } = await fixture(["codearts"]);

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        verify: createInitialHostVerificationHook({
          runner: successfulRunner(runtime, root),
          approvalProbe: async () => {
            throw new Error("probe rejected");
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });

    expect(await pathExists(plans[0]!.configPath)).toBe(false);
    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
  });
});

describe("stable Router process verification", () => {
  it("accepts only the three frozen Router MCP tools", () => {
    expect(hasExactRouterToolSet([
      "cloud_capability_describe",
      "cloud_action_execute",
      "cloud_capabilities_search",
    ])).toBe(true);
    expect(hasExactRouterToolSet([
      "cloud_capability_describe",
      "cloud_action_execute",
      "cloud_capabilities_search",
      "approval_grant",
    ])).toBe(false);
    expect(hasExactRouterToolSet([
      "cloud_capability_describe",
      "cloud_capabilities_search",
    ])).toBe(false);
  });
});

describe("host command runner", () => {
  it("rejects invalid command names before PATH inspection", async () => {
    const runner = new NodeHostCommandRunner();
    await expect(runner.resolveCommand("../codex")).rejects.toMatchObject({
      code: "HOST_VERIFICATION_FAILED",
    });
  });

  it.runIf(process.platform === "win32")(
    "resolves a bounded npm shim directly to its contained native executable",
    async () => {
      const root = await temporaryRoot();
      const target = resolve(
        root,
        "node_modules",
        "vendor",
        "tool",
        "bin",
        "claude.exe",
      );
      await mkdir(resolve(target, ".."), { recursive: true });
      await copyFile(process.execPath, target);
      await writeFile(
        resolve(root, "claude.cmd"),
        '@ECHO off\r\n"%dp0%\\node_modules\\vendor\\tool\\bin\\claude.exe" %*\r\n',
        "utf8",
      );
      const before = process.env.PATH;
      process.env.PATH = root;
      try {
        const runner = new NodeHostCommandRunner();
        await expect(runner.resolveCommand("claude")).resolves.toBe(
          await (await import("node:fs/promises")).realpath(target),
        );
      } finally {
        process.env.PATH = before;
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a cmd shim that contains arbitrary commands",
    async () => {
      const root = await temporaryRoot();
      await writeFile(
        resolve(root, "claude.cmd"),
        '@ECHO off\r\necho unsafe\r\n',
        "utf8",
      );
      const before = process.env.PATH;
      process.env.PATH = root;
      try {
        const runner = new NodeHostCommandRunner();
        await expect(runner.resolveCommand("claude")).resolves.toBeUndefined();
      } finally {
        process.env.PATH = before;
      }
    },
  );

  it("terminates commands that exceed the timeout", async () => {
    const runner = new NodeHostCommandRunner();
    await expect(
      runner.run(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10_000)"],
        50,
      ),
    ).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });
  });

  it("terminates commands whose output exceeds one MiB", async () => {
    const runner = new NodeHostCommandRunner();
    await expect(
      runner.run(process.execPath, [
        "-e",
        'process.stdout.write("x".repeat(1024 * 1024 + 1))',
      ]),
    ).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });
  });
});
