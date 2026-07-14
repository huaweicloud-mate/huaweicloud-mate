import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  type AppliedClaudeActivationChange,
  inspectClaudePluginActivationRollback,
  verifyClaudePluginActivation,
} from "./claude-activation.js";
import {
  type AppliedClaudeMarketplaceCatalogChange,
  type AppliedClaudeMarketplaceRegistration,
  createClaudeMarketplaceCatalogPlan,
  inspectClaudeMarketplaceCatalogRollback,
  inspectClaudeMarketplaceRegistrationRollback,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
} from "./claude-marketplace.js";
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

export interface BindClaudeInstallationOptions {
  readonly runtimeRoot: string;
  readonly snapshot: InstallStateSnapshot;
  readonly runner: HostCommandRunner;
  readonly homeDirectory?: string;
  readonly requireExecutable?: boolean;
}

export interface BoundClaudeInstallation {
  readonly snapshot: InstallStateSnapshot;
  readonly host: InstallStateHost;
  readonly runtime: MaterializedRuntime;
  readonly plan: HostInstallPlan;
  readonly assetChange: AppliedHostAssetChange;
  readonly catalogChange: AppliedClaudeMarketplaceCatalogChange;
  readonly registrationChange: AppliedClaudeMarketplaceRegistration;
  readonly activationChange: AppliedClaudeActivationChange;
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

export async function bindClaudeInstallation(
  options: BindClaudeInstallationOptions,
): Promise<BoundClaudeInstallation> {
  const { snapshot, runner } = options;
  const runtimeRoot = resolve(options.runtimeRoot);
  if (
    !isAbsolute(options.runtimeRoot) ||
    snapshot.state.hosts.length !== 1 ||
    snapshot.state.hosts[0]?.id !== "claude"
  ) {
    return conflict("Claude operation requires a single-host Claude install state");
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
    registry.get("claude"),
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
    return conflict("Install state does not match the fixed Claude layout");
  }
  const registration = host.registration;
  if (
    registration === undefined ||
    registration.kind !== "claude-local-marketplace"
  ) {
    return invalid("Claude install state is missing registration evidence");
  }
  const catalogPlan = createClaudeMarketplaceCatalogPlan(
    plan.pluginTargetPath,
    runtime.pluginVersion,
  );
  if (
    !samePath(registration.marketplaceRoot, catalogPlan.marketplaceRoot) ||
    !samePath(registration.manifestPath, catalogPlan.manifestPath) ||
    !samePath(registration.pluginPath, catalogPlan.pluginPath) ||
    registration.marketplaceName !== catalogPlan.marketplaceName ||
    registration.pluginName !== catalogPlan.pluginName ||
    registration.pluginVersion !== catalogPlan.pluginVersion ||
    registration.sourcePath !== catalogPlan.sourcePath
  ) {
    return conflict("Install state Claude marketplace paths were redirected");
  }

  let executablePath = resolve(runtimeRoot, "unowned-claude-command");
  if (
    registration.cli.changed ||
    registration.activation.changed ||
    options.requireExecutable === true
  ) {
    const discovered = await runner.resolveCommand("claude");
    if (discovered === undefined || !isAbsolute(discovered)) {
      return conflict("Claude command is unavailable for managed activation");
    }
    executablePath = discovered;
  }
  const catalogChange: AppliedClaudeMarketplaceCatalogChange = {
    ...catalogPlan,
    changed: registration.changed,
    createdFile: registration.createdFile,
    installedSha256: registration.installedSha256,
    createdPaths: registration.createdPaths,
  };
  const registrationChange: AppliedClaudeMarketplaceRegistration = {
    kind: "claude-cli-marketplace",
    executablePath,
    marketplaceRoot: registration.marketplaceRoot,
    marketplaceName: registration.marketplaceName,
    source: registration.cli.source,
    installedEntryHash: registration.cli.installedEntryHash,
    changed: registration.cli.changed,
    registered: true,
  };
  const activationChange: AppliedClaudeActivationChange = {
    ...registration.activation,
    executablePath,
  };
  const assetChange: AppliedHostAssetChange = {
    hostId: "claude",
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
    catalogChange,
    registrationChange,
    activationChange,
  };
}

export async function inspectBoundClaudeInstallation(
  bound: BoundClaudeInstallation,
  runner: HostCommandRunner,
): Promise<void> {
  await inspectClaudePluginActivationRollback(bound.activationChange, runner);
  if (bound.activationChange.changed) {
    await inspectClaudeMarketplaceRegistrationRollback(
      bound.registrationChange,
      runner,
    );
  }
  if (
    bound.activationChange.changed &&
    bound.registrationChange.changed
  ) {
    await inspectClaudeMarketplaceCatalogRollback(bound.catalogChange);
  }
  if (
    bound.activationChange.changed &&
    bound.registrationChange.changed &&
    bound.catalogChange.changed
  ) {
    await inspectHostAssetRollback(bound.assetChange);
  }
}

export async function verifyBoundClaudeInstallation(
  bound: BoundClaudeInstallation,
  runner: HostCommandRunner,
): Promise<void> {
  await verifyHostAssetChange(bound.assetChange);
  await verifyClaudeMarketplaceCatalog(bound.catalogChange);
  await verifyClaudeMarketplaceRegistration(bound.registrationChange, runner);
  await verifyClaudePluginActivation(bound.activationChange, runner);
}
