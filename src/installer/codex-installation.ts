import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  type AppliedCodexActivationChange,
  inspectCodexPluginActivationRollback,
  verifyCodexPluginActivation,
} from "./codex-activation.js";
import {
  type AppliedCodexMarketplaceChange,
  createCodexMarketplacePlan,
  inspectCodexMarketplaceRollback,
  verifyCodexMarketplaceChange,
} from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import {
  type AppliedHostAssetChange,
  inspectHostAssetRollback,
  verifyHostAssetChange,
} from "./host-assets.js";
import type {
  InstallStateHost,
  InstallStateSnapshot,
} from "./install-state.js";
import type { MaterializedRuntime } from "./runtime.js";

export interface BindCodexInstallationOptions {
  readonly runtimeRoot: string;
  readonly snapshot: InstallStateSnapshot;
  readonly runner: HostCommandRunner;
  readonly homeDirectory?: string;
  readonly requireExecutable?: boolean;
}

export interface BoundCodexInstallation {
  readonly snapshot: InstallStateSnapshot;
  readonly host: InstallStateHost;
  readonly runtime: MaterializedRuntime;
  readonly plan: HostInstallPlan;
  readonly assetChange: AppliedHostAssetChange;
  readonly registrationChange: AppliedCodexMarketplaceChange;
  readonly activationChange: AppliedCodexActivationChange;
}

function conflict(message: string): never {
  throw new InstallerError("INSTALL_STATE_CONFLICT", message);
}

function invalid(message: string): never {
  throw new InstallerError("INSTALL_STATE_INVALID", message);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

export async function bindCodexInstallation(
  options: BindCodexInstallationOptions,
): Promise<BoundCodexInstallation> {
  const { snapshot, runner } = options;
  const runtimeRoot = resolve(options.runtimeRoot);
  if (
    !isAbsolute(options.runtimeRoot) ||
    snapshot.state.hosts.length !== 1 ||
    snapshot.state.hosts[0]?.id !== "codex"
  ) {
    return conflict("Codex operation requires a single-host Codex install state");
  }
  const host = snapshot.state.hosts[0];
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(
      `${resolve(snapshot.state.runtimePath, "hosts", "templates")}${sep}`,
    ),
    pathToFileURL(
      `${resolve(snapshot.state.runtimePath, "contracts", "schema")}${sep}`,
    ),
  );
  const runtime: MaterializedRuntime = {
    pluginVersion: snapshot.state.pluginVersion,
    installManifestSha256: snapshot.state.installManifestSha256,
    runtimeRoot,
    versionDirectory: snapshot.state.runtimePath,
    stableLauncherPath: snapshot.state.stableLauncherPath,
    activeRuntimePath: resolve(runtimeRoot, "current", "active-runtime.json"),
    nodePath: process.execPath,
    reusedVersion: true,
  };
  const plan = createHostInstallPlan(
    registry.get("codex"),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    options.homeDirectory ?? homedir(),
  );
  if (
    plan.pluginSourcePath === undefined ||
    plan.pluginTargetPath === undefined ||
    host.mergeStrategy !== plan.mergeStrategy ||
    !samePath(host.configPath, plan.configPath) ||
    !samePath(host.asset.targetPath, plan.pluginTargetPath) ||
    host.asset.kind !== "plugin"
  ) {
    return conflict("Install state does not match the fixed Codex layout");
  }
  const registration = host.registration;
  if (
    registration === undefined ||
    registration.kind !== "codex-personal-marketplace"
  ) {
    return invalid("Codex install state is missing registration evidence");
  }
  const marketplacePlan = createCodexMarketplacePlan(plan.pluginTargetPath);
  if (
    !samePath(registration.pluginPath, marketplacePlan.pluginPath) ||
    !samePath(registration.marketplacePath, marketplacePlan.marketplacePath) ||
    registration.pluginName !== marketplacePlan.pluginName ||
    registration.sourcePath !== marketplacePlan.sourcePath
  ) {
    return conflict("Install state Codex registration paths were redirected");
  }
  if (registration.backupPath !== undefined) {
    const backupDirectory = resolve(
      runtimeRoot,
      "backups",
      "codex-marketplace",
    );
    if (
      !samePath(dirname(registration.backupPath), backupDirectory) ||
      !basename(registration.backupPath).endsWith(".bak")
    ) {
      return conflict("Install state Codex backup path was redirected");
    }
  }

  let executablePath = resolve(runtimeRoot, "unowned-codex-command");
  if (registration.activation.changed || options.requireExecutable === true) {
    const discovered = await runner.resolveCommand("codex");
    if (discovered === undefined || !isAbsolute(discovered)) {
      return conflict("Codex command is unavailable for managed activation");
    }
    executablePath = discovered;
  }
  const activationChange: AppliedCodexActivationChange = {
    ...registration.activation,
    executablePath,
  };
  const registrationChange: AppliedCodexMarketplaceChange = {
    ...marketplacePlan,
    marketplaceName: registration.marketplaceName,
    changed: registration.changed,
    createdFile: registration.createdFile,
    installedSha256: registration.installedSha256,
    installedEntryHash: registration.installedEntryHash,
    ...(registration.beforeSha256 === undefined
      ? {}
      : { beforeSha256: registration.beforeSha256 }),
    ...(registration.backupPath === undefined
      ? {}
      : { backupPath: registration.backupPath }),
    ...(registration.backupSha256 === undefined
      ? {}
      : { backupSha256: registration.backupSha256 }),
  };
  const assetChange: AppliedHostAssetChange = {
    hostId: "codex",
    kind: "plugin",
    sourcePath: plan.pluginSourcePath,
    targetPath: plan.pluginTargetPath,
    changed: host.asset.changed,
    installedTreeHash: host.asset.installedTreeHash,
    createdPaths: host.asset.changed ? [plan.pluginTargetPath] : [],
  };
  return {
    snapshot,
    host,
    runtime,
    plan,
    assetChange,
    registrationChange,
    activationChange,
  };
}

export async function inspectBoundCodexInstallation(
  bound: BoundCodexInstallation,
  runner: HostCommandRunner,
): Promise<void> {
  await inspectCodexPluginActivationRollback(bound.activationChange, runner);
  await inspectCodexMarketplaceRollback(bound.registrationChange);
  await inspectHostAssetRollback(bound.assetChange);
}

export async function verifyBoundCodexInstallation(
  bound: BoundCodexInstallation,
  runner: HostCommandRunner,
): Promise<void> {
  await verifyHostAssetChange(bound.assetChange);
  await verifyCodexMarketplaceChange(bound.registrationChange);
  await verifyCodexPluginActivation(bound.activationChange, runner);
}
