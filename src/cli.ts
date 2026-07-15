#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { runApprovalDoctor } from "./doctor/approval-doctor.js";
import { pluginVersion as version } from "./version.js";
import { CredentialStore } from "./auth/credentials.js";
import { AuthError } from "./auth/errors.js";
import type { CredentialPermissionPolicy } from "./auth/permissions.js";
import { TerminalCredentialPrompter } from "./auth/prompt.js";
import {
  AuthService,
} from "./auth/service.js";
import type {
  CredentialIdentityVerifier,
  CredentialPrompter,
  CredentialSessionRevoker,
} from "./auth/types.js";
import { runContractDoctor } from "./doctor/contract-doctor.js";
import { runHostDoctor } from "./doctor/host-doctor.js";
import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "./hosts/command-runner.js";
import { detectInstallableHosts } from "./hosts/detection.js";
import { createHostInstallPlan } from "./hosts/plan.js";
import { HostTemplateRegistry } from "./hosts/registry.js";
import type { HostId } from "./hosts/types.js";
import { createInitialHostVerificationHook } from "./hosts/verification.js";
import { uninstallClaude } from "./installer/claude-uninstall.js";
import { upgradeClaude } from "./installer/claude-upgrade.js";
import { readClaudeUpgradeRecovery } from "./installer/claude-upgrade-recovery-state.js";
import { uninstallConfigHost } from "./installer/config-host-uninstall.js";
import { upgradeConfigHost } from "./installer/config-host-upgrade.js";
import { readConfigHostUpgradeRecovery } from "./installer/config-host-upgrade-recovery-state.js";
import { uninstallCodex } from "./installer/codex-uninstall.js";
import { upgradeCodex } from "./installer/codex-upgrade.js";
import { InstallerError } from "./installer/errors.js";
import { runInitialInstallTransaction } from "./installer/initial-install.js";
import { upgradeMultipleHosts } from "./installer/multi-host-upgrade.js";
import { readMultiHostUpgradeRecovery } from "./installer/multi-host-upgrade-recovery-state.js";
import {
  installStatePath,
  readInstallState,
} from "./installer/install-state.js";
import {
  defaultCredentialsPath,
  defaultRuntimeRoot,
} from "./installer/paths.js";
import { materializeStableRuntime } from "./installer/runtime.js";
import {
  defaultRuntimePermissionPolicy,
  type RuntimePermissionPolicy,
} from "./installer/runtime-permissions.js";
import { readCodexUpgradeRecovery } from "./installer/upgrade-recovery.js";
import { runDevelopmentMcpServer } from "./mcp/stdio.js";
import type { KooCliArtifactBinding } from "./koocli/artifacts.js";
import type { KooCliArtifactFetcher } from "./koocli/installer.js";
import { releasedKooCliArtifacts } from "./koocli/release-artifacts.js";
import {
  ensureKooCliAvailable,
  inspectKooCliAvailability,
} from "./koocli/selection.js";
import {
  LocalObsSessionManager,
  ObsCredentialIdentityVerifier,
} from "./providers/obs/session.js";


function printUsage(): void {
  console.log(`huaweicloud-mate ${version}

Usage:
  huaweicloud-mate install [--host <codex|claude|opencode|codearts>] [--json]
  huaweicloud-mate uninstall --host <codex|claude|opencode|codearts> [--json]
  huaweicloud-mate auth <set|status|remove> [--json]
  huaweicloud-mate doctor [--contracts-only | --approval-probe | --koocli | --hosts] [--json]
  huaweicloud-mate router --stdio
  huaweicloud-mate mcp
  huaweicloud-mate version`);
}

export interface CliDependencies {
  readonly sourceDirectory?: string;
  readonly runtimeRoot?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe?: () => Promise<void>;
  readonly credentialsPath?: string;
  readonly credentialPermissions?: CredentialPermissionPolicy;
  readonly credentialPrompter?: CredentialPrompter;
  readonly credentialIdentityVerifier?: CredentialIdentityVerifier;
  readonly credentialSessionRevoker?: CredentialSessionRevoker;
  readonly runtimePermissions?: RuntimePermissionPolicy;
  readonly obsSessions?: LocalObsSessionManager;
  readonly koocliArtifacts?: readonly KooCliArtifactBinding[];
  readonly koocliFetcher?: KooCliArtifactFetcher;
  readonly contractDirectory?: URL;
}

interface HostArguments {
  readonly host?: HostId;
  readonly json: boolean;
}

function parseHostArguments(
  command: "install" | "uninstall",
  args: readonly string[],
  requireHost: boolean,
): HostArguments | undefined {
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
  if (host === undefined && !requireHost) {
    return { json };
  }
  if (
    host !== "codex" &&
    host !== "claude" &&
    host !== "opencode" &&
    host !== "codearts"
  ) {
    console.error(
      host === undefined
        ? `${command} requires --host codex, claude, opencode, or codearts`
        : `${command} supports only --host codex, claude, opencode, or codearts`,
    );
    return undefined;
  }
  return { host, json };
}

function hostDisplayName(host: HostId): string {
  switch (host) {
    case "codex": return "Codex";
    case "claude": return "Claude";
    case "opencode": return "OpenCode";
    case "codearts": return "CodeArts";
  }
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

function cliCredentialsPath(dependencies: CliDependencies): string {
  return resolve(
    dependencies.credentialsPath ??
      defaultCredentialsPath(
        process.platform,
        dependencies.homeDirectory ?? homedir(),
      ),
  );
}

interface AuthArguments {
  readonly action: "set" | "status" | "remove";
  readonly json: boolean;
}

function parseAuthArguments(args: readonly string[]): AuthArguments | undefined {
  const [action, ...options] = args;
  if (action !== "set" && action !== "status" && action !== "remove") {
    console.error("auth requires exactly one action: set, status, or remove");
    return undefined;
  }
  if (options.length > 1 || (options.length === 1 && options[0] !== "--json")) {
    console.error(`Unknown auth option: ${String(options[0])}`);
    return undefined;
  }
  return { action, json: options[0] === "--json" };
}

async function runAuth(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseAuthArguments(args);
  if (parsed === undefined) {
    return 2;
  }
  const obsSessions = dependencies.obsSessions ?? new LocalObsSessionManager();
  const service = new AuthService({
    store: new CredentialStore({
      path: cliCredentialsPath(dependencies),
      ...(dependencies.credentialPermissions === undefined
        ? {}
        : { permissions: dependencies.credentialPermissions }),
    }),
    prompter: dependencies.credentialPrompter ?? new TerminalCredentialPrompter(),
    identityVerifier:
      dependencies.credentialIdentityVerifier ??
      new ObsCredentialIdentityVerifier(obsSessions),
    sessionRevoker: dependencies.credentialSessionRevoker ?? obsSessions,
  });
  if (parsed.action === "status") {
    const result = await service.status();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!result.configured) {
      console.log("Huawei Cloud credentials are not configured.");
    } else {
      console.log(`Huawei Cloud credentials are configured for account ${result.accountIdentity.accountId}.`);
      console.log(`Last verified: ${result.updatedAt}`);
    }
    return 0;
  }
  const result = parsed.action === "set"
    ? await service.set()
    : await service.remove();
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if ("status" in result && result.status === "not-configured") {
    console.log("Huawei Cloud credentials are not configured.");
  } else if ("status" in result && result.status === "removed") {
    console.log("Huawei Cloud credentials removed.");
  } else if ("status" in result && result.status === "configured") {
    console.log(`Huawei Cloud credentials verified for account ${result.accountIdentity?.accountId ?? "unknown"}.`);
  }
  if ("warnings" in result) {
    for (const warning of result.warnings) {
      console.error(`Warning: ${warning}`);
    }
  }
  return 0;
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

async function hasManagedInstallState(
  runtimeRoot: string,
  requestedHost?: HostId,
): Promise<boolean> {
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
  const [state, codexRecovery, claudeRecovery, configHostRecovery, multiHostRecovery] = await Promise.all([
    readInstallState(runtimeRoot),
    readCodexUpgradeRecovery(runtimeRoot),
    readClaudeUpgradeRecovery(runtimeRoot),
    readConfigHostUpgradeRecovery(runtimeRoot),
    readMultiHostUpgradeRecovery(runtimeRoot),
  ]);
  const recoveryCount = [codexRecovery, claudeRecovery, configHostRecovery, multiHostRecovery]
    .filter((value) => value !== undefined).length;
  if (recoveryCount > 1) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multiple host upgrade recovery markers exist",
    );
  }
  if (
    requestedHost === undefined &&
    (codexRecovery !== undefined ||
      claudeRecovery !== undefined ||
      configHostRecovery !== undefined)
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Interrupted single-host upgrade must be recovered with an explicit --host",
    );
  }
  if (requestedHost !== undefined && multiHostRecovery !== undefined) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Interrupted multi-host upgrade must be recovered with automatic install",
    );
  }
  if (
    (codexRecovery !== undefined && requestedHost !== "codex") ||
    (claudeRecovery !== undefined && requestedHost !== "claude") ||
    (configHostRecovery !== undefined &&
      requestedHost !== configHostRecovery.recovery.host)
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Interrupted upgrade must be recovered with its original host",
    );
  }
  if (
    state === undefined &&
    (codexRecovery !== undefined ||
      claudeRecovery !== undefined ||
      configHostRecovery !== undefined ||
      multiHostRecovery !== undefined)
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Upgrade recovery marker exists without an install state",
    );
  }
  return state !== undefined;
}

async function discoverInstallableHostIds(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
  sourceDirectory?: string,
  contractDirectory?: URL,
): Promise<readonly HostId[]> {
  const registry = sourceDirectory === undefined
    ? await HostTemplateRegistry.loadBuiltIn(contractDirectory)
    : await HostTemplateRegistry.load(
        pathToFileURL(
          `${resolve(sourceDirectory, "hosts", "templates")}${sep}`,
        ),
        pathToFileURL(
          `${resolve(sourceDirectory, "contracts", "schema")}${sep}`,
        ),
      );
  const discoveryRuntime = {
    pluginVersion: version,
    installManifestSha256: `sha256:${"0".repeat(64)}`,
    runtimeRoot,
    versionDirectory: resolve(runtimeRoot, "versions", version),
    stableLauncherPath: resolve(runtimeRoot, "current", "hcloud-agent.mjs"),
    activeRuntimePath: resolve(runtimeRoot, "current", "active-runtime.json"),
    nodePath: process.execPath,
    reusedVersion: true,
  } as const;
  const plans = registry.list().map((template) =>
    createHostInstallPlan(
      template,
      discoveryRuntime,
      process.platform as "win32" | "darwin" | "linux",
      homeDirectory,
    )
  );
  return (await detectInstallableHosts(plans, runner))
    .filter((host) => host.installable)
    .map((host) => host.id);
}

async function reverifyAutomaticManagedInstall(
  dependencies: CliDependencies,
  runtimeRoot: string,
  runner: HostCommandRunner,
  approvalProbe: () => Promise<void>,
  json: boolean,
): Promise<number> {
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    throw new InstallerError(
      "INSTALL_STATE_CONFLICT",
      "Automatic managed reinstall requires an install state",
    );
  }
  if (snapshot.state.hosts.length === 1) {
    const host = snapshot.state.hosts[0]?.id;
    if (host === undefined) {
      throw new InstallerError(
        "INSTALL_STATE_INVALID",
        "Managed install state contains no host",
      );
    }
    return await runInstall(
      ["--host", host, ...(json ? ["--json"] : [])],
      dependencies,
    );
  }
  const result = await upgradeMultipleHosts({
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
    nextStep: result.changed
      ? "Start new sessions in the upgraded hosts to load the plugin."
      : undefined,
  } as const;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (result.status === "upgraded") {
    console.log(
      `Huawei Cloud plugin upgraded for ${result.hosts.map(hostDisplayName).join(", ")} from ${result.previousVersion} to ${result.pluginVersion}.`,
    );
    console.log(report.nextStep);
  } else {
    console.log(
      `Huawei Cloud plugin is already current for ${result.hosts.map(hostDisplayName).join(", ")} (${result.pluginVersion}).`,
    );
  }
  return 0;
}

async function assertNoUpgradeRecoveryBeforeUninstall(
  runtimeRoot: string,
): Promise<void> {
  try {
    const entry = await lstat(runtimeRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
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
  const [codexRecovery, claudeRecovery, configHostRecovery, multiHostRecovery] = await Promise.all([
    readCodexUpgradeRecovery(runtimeRoot),
    readClaudeUpgradeRecovery(runtimeRoot),
    readConfigHostUpgradeRecovery(runtimeRoot),
    readMultiHostUpgradeRecovery(runtimeRoot),
  ]);
  if (
    codexRecovery !== undefined ||
    claudeRecovery !== undefined ||
    configHostRecovery !== undefined ||
    multiHostRecovery !== undefined
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Run install to recover the interrupted upgrade before uninstalling",
    );
  }
}

async function runInstall(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseHostArguments("install", args, false);
  if (parsed === undefined) {
    return 2;
  }
  const runtimeRoot = cliRuntimeRoot(dependencies);
  const runner = dependencies.runner ?? new NodeHostCommandRunner();
  const runtimePermissions = dependencies.runtimePermissions ??
    defaultRuntimePermissionPolicy(process.platform, runner);
  const approvalProbe = dependencies.approvalProbe ?? defaultApprovalProbe;
  const koocliArtifacts = dependencies.koocliArtifacts ?? releasedKooCliArtifacts;
  await runtimePermissions.secureRoot(runtimeRoot);
  const managed = await hasManagedInstallState(runtimeRoot, parsed.host);
  if (managed && koocliArtifacts.length > 0) {
    await ensureKooCliAvailable(
      runtimeRoot,
      runner,
      koocliArtifacts,
      dependencies.koocliFetcher,
    );
  }
  if (managed) {
    if (parsed.host === undefined) {
      return await reverifyAutomaticManagedInstall(
        dependencies,
        runtimeRoot,
        runner,
        approvalProbe,
        parsed.json,
      );
    }
    if (parsed.host === "opencode" || parsed.host === "codearts") {
      const result = await upgradeConfigHost({
        host: parsed.host,
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
        nextStep: `Start a new ${hostDisplayName(parsed.host)} session to load the plugin.`,
      } as const;
      if (parsed.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (result.status === "unchanged") {
        console.log(
          `${hostDisplayName(parsed.host)} plugin is already current (${report.pluginVersion}).`,
        );
      } else {
        console.log(
          `${hostDisplayName(parsed.host)} plugin upgraded from ${result.previousVersion} to ${result.pluginVersion}.`,
        );
        console.log(report.nextStep);
      }
      return 0;
    }
    if (parsed.host === "claude") {
      const result = await upgradeClaude({
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
        nextStep: "Start a new Claude Code session to load the plugin.",
      } as const;
      if (parsed.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (result.status === "unchanged") {
        console.log(
          `Claude plugin is already current (${result.pluginVersion}).`,
        );
      } else {
        console.log(
          `Claude plugin upgraded from ${result.previousVersion} to ${result.pluginVersion}.`,
        );
        console.log(report.nextStep);
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
  const selectedHostIds = parsed.host === undefined
    ? await discoverInstallableHostIds(
        runtimeRoot,
        dependencies.homeDirectory ?? homedir(),
        runner,
        dependencies.sourceDirectory,
        dependencies.contractDirectory,
      )
    : [parsed.host];
  if (selectedHostIds.length === 0) {
    throw new InstallerError(
      "HOST_DISCOVERY_FAILED",
      "No supported host is available for automatic installation",
    );
  }
  const runtime = await materializeStableRuntime({
    ...(dependencies.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: dependencies.sourceDirectory }),
    runtimeRoot,
  });
  if (koocliArtifacts.length > 0) {
    await ensureKooCliAvailable(
      runtimeRoot,
      runner,
      koocliArtifacts,
      dependencies.koocliFetcher,
    );
  }
  const registry = await loadRuntimeHostRegistry(runtime.versionDirectory);
  const plans = selectedHostIds.map((host) =>
    createHostInstallPlan(
      registry.get(host),
      runtime,
      process.platform as "win32" | "darwin" | "linux",
      dependencies.homeDirectory ?? homedir(),
    )
  );
  const result = await runInitialInstallTransaction({
    runtime,
    plans,
    codexRunner: runner,
    claudeRunner: runner,
    verify: createInitialHostVerificationHook({
      runner,
      approvalProbe,
    }),
  });
  const commonReport = {
    status: "installed",
    changed: result.stateChange.changed,
    pluginVersion: result.state.pluginVersion,
    runtimePath: result.state.runtimePath,
    statePath: installStatePath(runtime.runtimeRoot),
  } as const;
  const report = parsed.host === undefined
    ? {
        ...commonReport,
        hosts: selectedHostIds,
        nextStep: "Start new sessions in the installed hosts to load the plugin.",
      } as const
    : {
        ...commonReport,
        host: parsed.host,
        nextStep: parsed.host === "codex"
          ? "Start a new Codex task to load the plugin."
          : `Start a new ${hostDisplayName(parsed.host)} session to load the plugin.`,
      } as const;
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const scope = parsed.host === undefined
      ? selectedHostIds.map(hostDisplayName).join(", ")
      : hostDisplayName(parsed.host);
    console.log(`Huawei Cloud plugin installed for ${scope} (${report.pluginVersion}).`);
    console.log(report.nextStep);
  }
  return 0;
}

async function runUninstall(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseHostArguments("uninstall", args, true);
  if (parsed === undefined || parsed.host === undefined) {
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
  try {
    await lstat(uninstallOptions.runtimeRoot);
    const runner = dependencies.runner ?? new NodeHostCommandRunner();
    await (dependencies.runtimePermissions ??
      defaultRuntimePermissionPolicy(process.platform, runner))
      .verifyRoot(uninstallOptions.runtimeRoot);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await assertNoUpgradeRecoveryBeforeUninstall(uninstallOptions.runtimeRoot);
  const result = parsed.host === "codex"
    ? await uninstallCodex(uninstallOptions)
    : parsed.host === "claude"
      ? await uninstallClaude(uninstallOptions)
      : await uninstallConfigHost({
          host: parsed.host,
          runtimeRoot: uninstallOptions.runtimeRoot,
          ...(dependencies.homeDirectory === undefined
            ? {}
            : { homeDirectory: dependencies.homeDirectory }),
        });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "not-installed") {
    console.log(
      `${hostDisplayName(parsed.host)} plugin is not installed by huaweicloud-mate.`,
    );
  } else {
    console.log(
      `${hostDisplayName(parsed.host)} plugin uninstalled; verified runtime cache retained.`,
    );
  }
  return 0;
}

async function runDoctor(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const allowedArguments = new Set([
    "--contracts-only",
    "--approval-probe",
    "--koocli",
    "--hosts",
    "--json",
  ]);
  const unknownArgument = args.find((argument) => !allowedArguments.has(argument));
  if (unknownArgument !== undefined) {
    console.error(`Unknown doctor option: ${unknownArgument}`);
    return 2;
  }
  const exclusiveModes = ["--contracts-only", "--approval-probe", "--koocli", "--hosts"]
    .filter((option) => args.includes(option));
  if (exclusiveModes.length > 1) {
    console.error("--contracts-only, --approval-probe, --koocli, and --hosts cannot be used together");
    return 2;
  }

  const contractReport = await runContractDoctor(dependencies.contractDirectory);
  const approvalProbe = args.includes("--approval-probe")
    ? await runApprovalDoctor()
    : undefined;
  const koocli = args.includes("--koocli")
    ? await inspectKooCliAvailability(
        cliRuntimeRoot(dependencies),
        dependencies.runner ?? new NodeHostCommandRunner(),
        dependencies.koocliArtifacts ?? releasedKooCliArtifacts,
      )
    : undefined;
  const hostReport = args.includes("--hosts")
    ? await runHostDoctor({
        runtimeRoot: cliRuntimeRoot(dependencies),
        ...(dependencies.homeDirectory === undefined
          ? {}
          : { homeDirectory: dependencies.homeDirectory }),
        ...(dependencies.runner === undefined
          ? {}
          : { runner: dependencies.runner }),
        ...(dependencies.contractDirectory === undefined
          ? {}
          : { contractDirectory: dependencies.contractDirectory }),
      })
    : undefined;
  const ok = contractReport.ok &&
    (approvalProbe?.ok ?? true) &&
    (koocli?.compatible ?? true) &&
    (hostReport?.ok ?? true);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ...contractReport,
          ok,
          ...(approvalProbe === undefined ? {} : { approvalProbe }),
          ...(koocli === undefined ? {} : { koocli }),
          ...(hostReport === undefined ? {} : { hostReport }),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Contract doctor: ${contractReport.ok ? "PASS" : "FAIL"} (${contractReport.schemaCount} schemas, ${contractReport.vectorCount} schema vectors, ${contractReport.stateMachineVectorCount} state-machine vectors, ${contractReport.deferredStateMachineVectorCount} deferred)`,
    );
    for (const vector of contractReport.vectors) {
      console.log(
        `- ${vector.passed ? "PASS" : "FAIL"} ${vector.id}: expectation=${vector.expectation}, schemaValid=${String(vector.schemaValid)}${vector.semanticValid === undefined ? "" : `, semanticValid=${String(vector.semanticValid)}`}`,
      );
    }
    for (const vector of contractReport.stateMachineVectors) {
      console.log(
        `- ${vector.passed ? "PASS" : "FAIL"} ${vector.id}: expected=${vector.expected.join(",")}, observed=${vector.observed.join(",")}`,
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
    if (koocli !== undefined) {
      console.log(
        `KooCLI: ${koocli.compatible ? "PASS" : "FAIL"} (${koocli.status}${"version" in koocli ? `, ${koocli.version}, ${koocli.source}` : ""})`,
      );
    }
    if (hostReport !== undefined) {
      console.log(
        `Host integration: ${hostReport.ok ? "PASS" : "FAIL"} (${hostReport.installState})`,
      );
      for (const host of hostReport.hosts) {
        console.log(
          `- ${host.displayName}: ${host.status} (command=${host.commandDetected ? "yes" : "no"}, paths=${host.detectedPathCount}, managed=${host.managed ? "yes" : "no"})${host.errorCode === undefined ? "" : `, errorCode=${host.errorCode}`}`,
        );
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
    case "auth":
      return runAuth(commandArguments, dependencies);
    case "doctor":
      return runDoctor(commandArguments, dependencies);
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
      error instanceof InstallerError || error instanceof AuthError
        ? `${error.code}: ${error.message}`
        : "huaweicloud-mate failed to start",
    );
    process.exitCode = 1;
  }
}
