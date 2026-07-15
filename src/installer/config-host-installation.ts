import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import type { HostId } from "../hosts/types.js";
import {
  type AppliedHostConfigChange,
  inspectHostConfigRollback,
  verifyHostConfigChange,
} from "./config-transaction.js";
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

export type ConfigHostId = Extract<HostId, "opencode" | "codearts">;

export interface BindConfigHostInstallationOptions {
  readonly host: ConfigHostId;
  readonly runtimeRoot: string;
  readonly snapshot: InstallStateSnapshot;
  readonly homeDirectory?: string;
  readonly allowMultiHost?: boolean;
}

export interface BoundConfigHostInstallation {
  readonly snapshot: InstallStateSnapshot;
  readonly host: InstallStateHost;
  readonly runtime: MaterializedRuntime;
  readonly plan: HostInstallPlan;
  readonly configChange: AppliedHostConfigChange;
  readonly assetChange: AppliedHostAssetChange;
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

export async function bindConfigHostInstallation(
  options: BindConfigHostInstallationOptions,
): Promise<BoundConfigHostInstallation> {
  const { snapshot } = options;
  const runtimeRoot = resolve(options.runtimeRoot);
  if (
    !isAbsolute(options.runtimeRoot) ||
    (options.allowMultiHost !== true && snapshot.state.hosts.length !== 1)
  ) {
    return conflict(
      `${options.host} operation requires a matching single-host install state`,
    );
  }
  const host = snapshot.state.hosts.find((entry) => entry.id === options.host);
  if (host === undefined) {
    return conflict(`${options.host} is not present in the managed install state`);
  }
  if (host.registration !== undefined || host.config === undefined) {
    return invalid(`${options.host} install state has invalid config evidence`);
  }
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
    registry.get(options.host),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    options.homeDirectory ?? homedir(),
  );
  if (
    plan.mergeStrategy === "plugin-manifest" ||
    plan.pluginSourcePath !== undefined ||
    plan.pluginTargetPath !== undefined ||
    host.mergeStrategy !== plan.mergeStrategy ||
    host.asset.kind !== "skill" ||
    !samePath(host.configPath, plan.configPath) ||
    !samePath(host.asset.targetPath, plan.skillTargetPath) ||
    host.config.installedSha256 === undefined
  ) {
    return conflict(`${options.host} install state does not match the fixed layout`);
  }
  if (host.config.backupPath !== undefined) {
    const backupDirectory = resolve(runtimeRoot, "backups", options.host);
    if (
      !samePath(dirname(host.config.backupPath), backupDirectory) ||
      !basename(host.config.backupPath).endsWith(".bak")
    ) {
      return conflict(`${options.host} config backup path was redirected`);
    }
  }
  const configChange: AppliedHostConfigChange = {
    configPath: plan.configPath,
    entryKey: plan.entryKey,
    mergeStrategy: plan.mergeStrategy,
    changed: host.config.changed,
    createdFile: host.config.createdFile,
    installedSha256: host.config.installedSha256,
    installedValueHash: host.installedValueHash,
    ...(host.config.beforeSha256 === undefined
      ? {}
      : { beforeSha256: host.config.beforeSha256 }),
    ...(host.config.backupPath === undefined
      ? {}
      : { backupPath: host.config.backupPath }),
    ...(host.config.backupSha256 === undefined
      ? {}
      : { backupSha256: host.config.backupSha256 }),
  };
  const assetChange: AppliedHostAssetChange = {
    hostId: options.host,
    kind: "skill",
    sourcePath: plan.skillSourcePath,
    targetPath: plan.skillTargetPath,
    changed: host.asset.changed,
    installedTreeHash: host.asset.installedTreeHash,
    createdPaths: host.asset.createdPaths,
  };
  return { snapshot, host, runtime, plan, configChange, assetChange };
}

export async function inspectBoundConfigHostInstallation(
  bound: BoundConfigHostInstallation,
): Promise<void> {
  await inspectHostConfigRollback(bound.configChange);
  await inspectHostAssetRollback(bound.assetChange);
}

export async function verifyBoundConfigHostInstallation(
  bound: BoundConfigHostInstallation,
): Promise<void> {
  await verifyHostConfigChange(bound.configChange);
  await verifyHostAssetChange(bound.assetChange);
}
