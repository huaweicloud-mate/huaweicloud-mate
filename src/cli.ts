#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runApprovalDoctor } from "./doctor/approval-doctor.js";
import { runContractDoctor } from "./doctor/contract-doctor.js";
import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "./hosts/command-runner.js";
import { createHostInstallPlan } from "./hosts/plan.js";
import { HostTemplateRegistry } from "./hosts/registry.js";
import { createInitialHostVerificationHook } from "./hosts/verification.js";
import {
  bindClaudeInstallation,
  verifyBoundClaudeInstallation,
} from "./installer/claude-installation.js";
import { uninstallClaude } from "./installer/claude-uninstall.js";
import { uninstallCodex } from "./installer/codex-uninstall.js";
import { upgradeCodex } from "./installer/codex-upgrade.js";
import { InstallerError } from "./installer/errors.js";
import { runInitialInstallTransaction } from "./installer/initial-install.js";
import {
  installStatePath,
  readInstallState,
} from "./installer/install-state.js";
import { defaultRuntimeRoot } from "./installer/paths.js";
import { verifyInstallDirectory } from "./installer/install-manifest.js";
import { materializeStableRuntime } from "./installer/runtime.js";
import { readCodexUpgradeRecovery } from "./installer/upgrade-recovery.js";
import { runDevelopmentMcpServer } from "./mcp/stdio.js";

const version = "0.0.0-development";

function printUsage(): void {
  console.log(`huaweicloud-mate ${version}

Usage:
  huaweicloud-mate install --host <codex|claude> [--json]
  huaweicloud-mate uninstall --host <codex|claude> [--json]
  huaweicloud-mate doctor [--contracts-only | --approval-probe] [--json]
  huaweicloud-mate router --stdio
  huaweicloud-mate mcp
  huaweicloud-mate version

This development build does not accept credentials or execute cloud operations.`);
}

export interface CliDependencies {
  readonly sourceDirectory?: string;
  readonly runtimeRoot?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe?: () => Promise<void>;
}

interface ManagedHostArguments {
  readonly host: "codex" | "claude";
  readonly json: boolean;
}

function parseManagedHostArguments(
  command: "install" | "uninstall",
  args: readonly string[],
): ManagedHostArguments | undefined {
  let host: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) {
        console.error(`Duplicate ${command} option: --json`);
        return undefined;
      }
      json = true;
      continue;
    }
    if (argument === "--host") {
      if (host !== undefined || index + 1 >= args.length) {
        console.error(`${command} requires exactly one --host value`);
        return undefined;
      }
      host = args[index + 1];
      index += 1;
      continue;
    }
    console.error(`Unknown ${command} option: ${String(argument)}`);
    return undefined;
  }
  if (host !== "codex" && host !== "claude") {
    console.error(
      host === undefined
        ? `${command} requires --host codex or --host claude`
        : `${command} supports only --host codex or --host claude`,
    );
    return undefined;
  }
  return { host, json };
}

function cliRuntimeRoot(dependencies: CliDependencies): string {
  return resolve(
    dependencies.runtimeRoot ??
      defaultRuntimeRoot(
        process.platform,
        dependencies.homeDirectory ?? homedir(),
      ),
  );
}

async function loadRuntimeHostRegistry(
  runtimePath: string,
): Promise<HostTemplateRegistry> {
  return await HostTemplateRegistry.load(
    pathToFileURL(`${resolve(runtimePath, "hosts", "templates")}${sep}`),
    pathToFileURL(`${resolve(runtimePath, "contracts", "schema")}${sep}`),
  );
}

async function defaultApprovalProbe(): Promise<void> {
  const report = await runApprovalDoctor();
  if (!report.ok) {
    throw new InstallerError("HOST_VERIFICATION_FAILED", report.message);
  }
}

async function hasManagedInstallState(runtimeRoot: string): Promise<boolean> {
  try {
    const entry = await lstat(runtimeRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new InstallerError(
        "INSTALL_TRANSACTION_CONFLICT",
        "Runtime root is not a regular directory",
      );
    }
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
  const state = await readInstallState(runtimeRoot);
  const recovery = await readCodexUpgradeRecovery(runtimeRoot);
  if (state === undefined && recovery !== undefined) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Codex upgrade recovery marker exists without an install state",
    );
  }
  return state !== undefined;
}

async function runInstall(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseManagedHostArguments("install", args);
  if (parsed === undefined) {
    return 2;
  }
  const runtimeRoot = cliRuntimeRoot(dependencies);
  const runner = dependencies.runner ?? new NodeHostCommandRunner();
  const approvalProbe = dependencies.approvalProbe ?? defaultApprovalProbe;
  if (await hasManagedInstallState(runtimeRoot)) {
    if (parsed.host === "claude") {
      const snapshot = await readInstallState(runtimeRoot);
      if (snapshot === undefined) {
        throw new InstallerError(
          "INSTALL_STATE_CONFLICT",
          "Managed install state disappeared during Claude verification",
        );
      }
      const sourceDirectory = resolve(
        dependencies.sourceDirectory ??
          dirname(
            fileURLToPath(new URL("./install-manifest.json", import.meta.url)),
          ),
      );
      const source = await verifyInstallDirectory(sourceDirectory);
      if (
        source.manifest.pluginVersion !== snapshot.state.pluginVersion ||
        source.manifestSha256 !== snapshot.state.installManifestSha256
      ) {
        throw new InstallerError(
          "INSTALL_TRANSACTION_CONFLICT",
          "Claude managed upgrade is not available yet; uninstall before installing a different version",
        );
      }
      const bound = await bindClaudeInstallation({
        runtimeRoot,
        snapshot,
        runner,
        requireExecutable: true,
        ...(dependencies.homeDirectory === undefined
          ? {}
          : { homeDirectory: dependencies.homeDirectory }),
      });
      await verifyBoundClaudeInstallation(bound, runner);
      await approvalProbe();
      const report = {
        host: "claude",
        status: "unchanged",
        changed: false,
        pluginVersion: snapshot.state.pluginVersion,
        runtimePath: snapshot.state.runtimePath,
        statePath: installStatePath(runtimeRoot),
        nextStep: "Start a new Claude Code session to load the plugin.",
      } as const;
      if (parsed.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `Claude plugin is already current (${report.pluginVersion}).`,
        );
      }
      return 0;
    }
    const result = await upgradeCodex({
      runtimeRoot,
      ...(dependencies.sourceDirectory === undefined
        ? {}
        : { sourceDirectory: dependencies.sourceDirectory }),
      ...(dependencies.homeDirectory === undefined
        ? {}
        : { homeDirectory: dependencies.homeDirectory }),
      runner,
      approvalProbe,
    });
    const report = {
      ...result,
      statePath: installStatePath(runtimeRoot),
      nextStep: "Start a new Codex task to load the plugin.",
    } as const;
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (result.status === "unchanged") {
      console.log(`Codex plugin is already current (${result.pluginVersion}).`);
    } else {
      console.log(
        `Codex plugin upgraded from ${result.previousVersion} to ${result.pluginVersion}.`,
      );
      console.log(report.nextStep);
    }
    return 0;
  }
  const runtime = await materializeStableRuntime({
    ...(dependencies.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: dependencies.sourceDirectory }),
    runtimeRoot,
  });
  const registry = await loadRuntimeHostRegistry(runtime.versionDirectory);
  const plan = createHostInstallPlan(
    registry.get(parsed.host),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    dependencies.homeDirectory ?? homedir(),
  );
  const result = await runInitialInstallTransaction({
    runtime,
    plans: [plan],
    codexRunner: runner,
    claudeRunner: runner,
    verify: createInitialHostVerificationHook({
      runner,
      approvalProbe,
    }),
  });
  const report = {
    host: parsed.host,
    status: "installed",
    changed: result.stateChange.changed,
    pluginVersion: result.state.pluginVersion,
    runtimePath: result.state.runtimePath,
    statePath: installStatePath(runtime.runtimeRoot),
    nextStep: parsed.host === "codex"
      ? "Start a new Codex task to load the plugin."
      : "Start a new Claude Code session to load the plugin.",
  } as const;
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${parsed.host === "codex" ? "Codex" : "Claude"} plugin installed (${report.pluginVersion}).`,
    );
    console.log(report.nextStep);
  }
  return 0;
}

async function runUninstall(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseManagedHostArguments("uninstall", args);
  if (parsed === undefined) {
    return 2;
  }
  const uninstallOptions = {
    runtimeRoot: cliRuntimeRoot(dependencies),
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
    ...(dependencies.runner === undefined
      ? {}
      : { runner: dependencies.runner }),
  };
  const result = parsed.host === "codex"
    ? await uninstallCodex(uninstallOptions)
    : await uninstallClaude(uninstallOptions);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "not-installed") {
    console.log(
      `${parsed.host === "codex" ? "Codex" : "Claude"} plugin is not installed by huaweicloud-mate.`,
    );
  } else {
    console.log(
      `${parsed.host === "codex" ? "Codex" : "Claude"} plugin uninstalled; verified runtime cache retained.`,
    );
  }
  return 0;
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const allowedArguments = new Set([
    "--contracts-only",
    "--approval-probe",
    "--json",
  ]);
  const unknownArgument = args.find((argument) => !allowedArguments.has(argument));
  if (unknownArgument !== undefined) {
    console.error(`Unknown doctor option: ${unknownArgument}`);
    return 2;
  }
  if (
    args.includes("--contracts-only") &&
    args.includes("--approval-probe")
  ) {
    console.error("--contracts-only and --approval-probe cannot be used together");
    return 2;
  }

  const contractReport = await runContractDoctor();
  const approvalProbe = args.includes("--approval-probe")
    ? await runApprovalDoctor()
    : undefined;
  const ok = contractReport.ok && (approvalProbe?.ok ?? true);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        approvalProbe === undefined
          ? contractReport
          : { ...contractReport, approvalProbe },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Contract doctor: ${contractReport.ok ? "PASS" : "FAIL"} (${contractReport.schemaCount} schemas, ${contractReport.vectorCount} schema vectors, ${contractReport.deferredStateMachineVectorCount} runtime vectors deferred)`,
    );
    for (const vector of contractReport.vectors) {
      console.log(
        `- ${vector.passed ? "PASS" : "FAIL"} ${vector.id}: expectation=${vector.expectation}, schemaValid=${String(vector.schemaValid)}`,
      );
    }
    if (approvalProbe !== undefined) {
      console.log(
        `Approval companion probe: ${approvalProbe.ok ? "PASS" : "FAIL"} (${approvalProbe.status}, no cloud operation)`,
      );
      console.log(`- ${approvalProbe.message}`);
      if (approvalProbe.errorCode !== undefined) {
        console.log(`- errorCode=${approvalProbe.errorCode}`);
      }
    }
  }
  return ok ? 0 : 1;
}

export async function main(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const [command, ...commandArguments] = args;
  switch (command) {
    case "install":
      return runInstall(commandArguments, dependencies);
    case "uninstall":
      return runUninstall(commandArguments, dependencies);
    case "doctor":
      return runDoctor(commandArguments);
    case "mcp":
      if (commandArguments.length > 0) {
        console.error(`Unknown mcp option: ${String(commandArguments[0])}`);
        return 2;
      }
      await runDevelopmentMcpServer();
      return 0;
    case "router":
      if (
        commandArguments.length !== 1 ||
        commandArguments[0] !== "--stdio"
      ) {
        console.error("Router requires exactly --stdio");
        return 2;
      }
      await runDevelopmentMcpServer();
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 2;
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof InstallerError
        ? `${error.code}: ${error.message}`
        : "huaweicloud-mate failed to start",
    );
    process.exitCode = 1;
  }
}
