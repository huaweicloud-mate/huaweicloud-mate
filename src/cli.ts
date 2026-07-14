#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { runApprovalDoctor } from "./doctor/approval-doctor.js";
import { runContractDoctor } from "./doctor/contract-doctor.js";
import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "./hosts/command-runner.js";
import { createHostInstallPlan } from "./hosts/plan.js";
import { HostTemplateRegistry } from "./hosts/registry.js";
import { createInitialHostVerificationHook } from "./hosts/verification.js";
import { uninstallCodex } from "./installer/codex-uninstall.js";
import { InstallerError } from "./installer/errors.js";
import { runInitialInstallTransaction } from "./installer/initial-install.js";
import {
  installStatePath,
  readInstallState,
} from "./installer/install-state.js";
import { defaultRuntimeRoot } from "./installer/paths.js";
import { materializeStableRuntime } from "./installer/runtime.js";
import { runDevelopmentMcpServer } from "./mcp/stdio.js";

const version = "0.0.0-development";

function printUsage(): void {
  console.log(`huaweicloud-mate ${version}

Usage:
  huaweicloud-mate install --host codex [--json]
  huaweicloud-mate uninstall --host codex [--json]
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
  readonly host: "codex";
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
  if (host !== "codex") {
    console.error(
      host === undefined
        ? `${command} requires --host codex`
        : `${command} currently supports only --host codex`,
    );
    return undefined;
  }
  return { host: "codex", json };
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

async function assertInitialInstallStateAbsent(runtimeRoot: string): Promise<void> {
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
      return;
    }
    throw error;
  }
  if ((await readInstallState(runtimeRoot)) !== undefined) {
    throw new InstallerError(
      "INSTALL_TRANSACTION_CONFLICT",
      "Install state already exists; managed upgrade is required",
    );
  }
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
  await assertInitialInstallStateAbsent(runtimeRoot);
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
  const runner = dependencies.runner ?? new NodeHostCommandRunner();
  const result = await runInitialInstallTransaction({
    runtime,
    plans: [plan],
    codexRunner: runner,
    verify: createInitialHostVerificationHook({
      runner,
      approvalProbe: dependencies.approvalProbe ?? defaultApprovalProbe,
    }),
  });
  const report = {
    host: parsed.host,
    status: "installed",
    changed: result.stateChange.changed,
    pluginVersion: result.state.pluginVersion,
    runtimePath: result.state.runtimePath,
    statePath: installStatePath(runtime.runtimeRoot),
    nextStep: "Start a new Codex task to load the plugin.",
  } as const;
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Codex plugin installed (${report.pluginVersion}).`);
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
  const result = await uninstallCodex({
    runtimeRoot: cliRuntimeRoot(dependencies),
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
    ...(dependencies.runner === undefined
      ? {}
      : { runner: dependencies.runner }),
  });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "not-installed") {
    console.log("Codex plugin is not installed by huaweicloud-mate.");
  } else {
    console.log("Codex plugin uninstalled; verified runtime cache retained.");
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
