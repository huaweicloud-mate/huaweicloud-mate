import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import type { HostId } from "../hosts/types.js";
import {
  createInitialHostVerificationHook,
  verifyInstalledHostBindings,
} from "../hosts/verification.js";
import {
  applyClaudePluginActivation,
  inspectClaudePluginActivationRollback,
  rollbackClaudePluginActivation,
  type AppliedClaudeActivationChange,
} from "./claude-activation.js";
import {
  bindClaudeInstallation,
  inspectBoundClaudeInstallation,
  verifyBoundClaudeInstallation,
  type BoundClaudeInstallation,
} from "./claude-installation.js";
import {
  applyClaudeMarketplaceCatalog,
  createClaudeMarketplaceCatalogPlan,
  expectedClaudeMarketplaceCatalogSha256,
  inspectClaudeMarketplaceCatalogRollback,
  rollbackClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
  type AppliedClaudeMarketplaceCatalogChange,
} from "./claude-marketplace.js";
import {
  applyCodexPluginActivation,
  inspectCodexPluginActivationRollback,
  rollbackCodexPluginActivation,
  type AppliedCodexActivationChange,
} from "./codex-activation.js";
import {
  bindCodexInstallation,
  inspectBoundCodexInstallation,
  verifyBoundCodexInstallation,
  type BoundCodexInstallation,
} from "./codex-installation.js";
import { verifyCodexMarketplaceChange } from "./codex-marketplace.js";
import {
  bindConfigHostInstallation,
  inspectBoundConfigHostInstallation,
  verifyBoundConfigHostInstallation,
  type BoundConfigHostInstallation,
  type ConfigHostId,
} from "./config-host-installation.js";
import {
  applyHostConfigChange,
  type AppliedHostConfigChange,
} from "./config-transaction.js";
import { InstallerError } from "./errors.js";
import {
  expectedHostAssetTreeHash,
  inspectHostAssetRollback,
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
  type AppliedHostAssetChange,
} from "./host-assets.js";
import { verifyInstallDirectory } from "./install-manifest.js";
import {
  createInstallState,
  installStateSha256,
  readInstallState,
  replaceInstallState,
  type CompletedHostInstallation,
  type InstallStateSnapshot,
} from "./install-state.js";
import {
  readMultiHostUpgradeRecovery,
  removeMultiHostUpgradeRecovery,
  replaceMultiHostUpgradeRecovery,
  type MultiHostUpgradeHostRecovery,
  type MultiHostUpgradeRecovery,
  type MultiHostUpgradeRecoverySnapshot,
} from "./multi-host-upgrade-recovery-state.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
  rollbackActiveRuntimeChange,
  type AppliedActiveRuntimeChange,
  type MaterializedRuntime,
} from "./runtime.js";

export interface MultiHostUpgradeOptions {
  readonly runtimeRoot: string;
  readonly sourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe: () => Promise<void>;
}

export interface MultiHostUpgradeResult {
  readonly status: "unchanged" | "upgraded";
  readonly changed: boolean;
  readonly hosts: readonly HostId[];
  readonly previousVersion: string;
  readonly pluginVersion: string;
  readonly runtimePath: string;
}

type BoundHost =
  | { readonly kind: "codex"; readonly bound: BoundCodexInstallation }
  | { readonly kind: "claude"; readonly bound: BoundClaudeInstallation }
  | { readonly kind: "config"; readonly bound: BoundConfigHostInstallation };

interface UpgradeHost {
  readonly id: HostId;
  readonly bound: BoundHost;
  readonly plan: HostInstallPlan;
  readonly candidateAssetTreeHash: string;
  readonly candidateCatalogSha256?: string;
  asset: AppliedHostAssetChange;
  catalog?: AppliedClaudeMarketplaceCatalogChange;
  codexActivation?: AppliedCodexActivationChange;
  claudeActivation?: AppliedClaudeActivationChange;
  oldAssetRemoved: boolean;
  oldCatalogRemoved: boolean;
  oldActivationRemoved: boolean;
  newAssetInstalled: boolean;
  newCatalogInstalled: boolean;
  newActivationInstalled: boolean;
}

function invalid(message: string): never {
  throw new InstallerError("UPGRADE_TRANSACTION_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("UPGRADE_TRANSACTION_CONFLICT", message);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function isolatedSnapshot(
  snapshot: InstallStateSnapshot,
  id: HostId,
): InstallStateSnapshot {
  const host = snapshot.state.hosts.find((entry) => entry.id === id);
  if (host === undefined) return conflict(`Managed host ${id} is missing`);
  return {
    sha256: snapshot.sha256,
    state: { ...snapshot.state, hosts: [host] },
  };
}

async function bindHost(
  snapshot: InstallStateSnapshot,
  id: HostId,
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<BoundHost> {
  const isolated = isolatedSnapshot(snapshot, id);
  switch (id) {
    case "codex": {
      const bound = await bindCodexInstallation({
        runtimeRoot,
        snapshot: isolated,
        runner,
        homeDirectory,
        requireExecutable: true,
      });
      await inspectBoundCodexInstallation(bound, runner);
      await verifyBoundCodexInstallation(bound, runner);
      return { kind: "codex", bound };
    }
    case "claude": {
      const bound = await bindClaudeInstallation({
        runtimeRoot,
        snapshot: isolated,
        runner,
        homeDirectory,
        requireExecutable: true,
      });
      await inspectBoundClaudeInstallation(bound, runner);
      await verifyBoundClaudeInstallation(bound, runner);
      return { kind: "claude", bound };
    }
    case "opencode":
    case "codearts": {
      const bound = await bindConfigHostInstallation({
        host: id,
        runtimeRoot,
        snapshot: isolated,
        homeDirectory,
      });
      await inspectBoundConfigHostInstallation(bound);
      await verifyBoundConfigHostInstallation(bound);
      return { kind: "config", bound };
    }
  }
}

function oldAsset(host: BoundHost): AppliedHostAssetChange {
  return host.bound.assetChange;
}

function oldPlan(host: BoundHost): HostInstallPlan {
  return host.bound.plan;
}

function oldRuntime(host: BoundHost): MaterializedRuntime {
  return host.bound.runtime;
}

function assertFixedPlan(bound: BoundHost, plan: HostInstallPlan): void {
  const previous = oldPlan(bound);
  const assetTarget = plan.mergeStrategy === "plugin-manifest"
    ? plan.pluginTargetPath
    : plan.skillTargetPath;
  if (
    plan.id !== previous.id ||
    plan.mergeStrategy !== previous.mergeStrategy ||
    assetTarget === undefined ||
    !samePath(plan.configPath, previous.configPath) ||
    !samePath(assetTarget, oldAsset(bound).targetPath)
  ) {
    return conflict(`Candidate ${plan.id} plan changes a fixed managed path`);
  }
}

async function createUpgradeHost(
  id: HostId,
  bound: BoundHost,
  plan: HostInstallPlan,
  candidate: MaterializedRuntime,
  runtimeRoot: string,
): Promise<UpgradeHost> {
  assertFixedPlan(bound, plan);
  if (bound.kind === "config") {
    const inspected = await applyHostConfigChange(
      plan,
      resolve(runtimeRoot, "backups", id),
    );
    if (
      inspected.changed ||
      inspected.installedValueHash !==
        bound.bound.configChange.installedValueHash
    ) {
      return conflict(`Candidate ${id} changes the managed config entry`);
    }
  }
  const candidateAssetTreeHash = await expectedHostAssetTreeHash(
    plan,
    candidate,
  );
  if (
    candidateAssetTreeHash !== oldAsset(bound).installedTreeHash &&
    !oldAsset(bound).changed
  ) {
    return conflict(`Candidate ${id} cannot replace an unowned host asset`);
  }
  if (
    bound.kind === "codex" &&
    candidateAssetTreeHash !== oldAsset(bound).installedTreeHash &&
    !bound.bound.activationChange.changed
  ) {
    return conflict("Candidate Codex cannot replace an unowned activation");
  }
  let candidateCatalogSha256: string | undefined;
  if (bound.kind === "claude") {
    if (
      !bound.bound.catalogChange.changed ||
      !bound.bound.activationChange.changed ||
      plan.pluginTargetPath === undefined
    ) {
      return conflict(
        "Candidate Claude cannot replace an unowned catalog or activation",
      );
    }
    candidateCatalogSha256 = expectedClaudeMarketplaceCatalogSha256(
      createClaudeMarketplaceCatalogPlan(
        plan.pluginTargetPath,
        candidate.pluginVersion,
      ),
    );
  }
  return {
    id,
    bound,
    plan,
    candidateAssetTreeHash,
    ...(candidateCatalogSha256 === undefined
      ? {}
      : { candidateCatalogSha256 }),
    asset: oldAsset(bound),
    ...(bound.kind === "claude" ? { catalog: bound.bound.catalogChange } : {}),
    ...(bound.kind === "codex"
      ? { codexActivation: bound.bound.activationChange }
      : {}),
    ...(bound.kind === "claude"
      ? { claudeActivation: bound.bound.activationChange }
      : {}),
    oldAssetRemoved: false,
    oldCatalogRemoved: false,
    oldActivationRemoved: false,
    newAssetInstalled: false,
    newCatalogInstalled: false,
    newActivationInstalled: false,
  };
}

function markerHost(host: UpgradeHost): MultiHostUpgradeHostRecovery {
  return {
    id: host.id,
    candidateAssetTreeHash: host.candidateAssetTreeHash,
    ...(host.candidateCatalogSha256 === undefined
      ? {}
      : { candidateCatalogSha256: host.candidateCatalogSha256 }),
    ...(host.newActivationInstalled && host.codexActivation !== undefined
      ? {
          codexActivation: {
            pluginId: host.codexActivation.pluginId,
            version: host.codexActivation.version,
            installedEntryHash: host.codexActivation.installedEntryHash,
          },
        }
      : {}),
    ...(host.newActivationInstalled && host.claudeActivation !== undefined
      ? {
          claudeActivation: {
            pluginId: host.claudeActivation.pluginId,
            version: host.claudeActivation.version,
            installPath: host.claudeActivation.installPath,
            installedEntryHash: host.claudeActivation.installedEntryHash,
          },
        }
      : {}),
  };
}

async function refreshMarker(
  runtimeRoot: string,
  marker: MultiHostUpgradeRecoverySnapshot,
  hosts: readonly UpgradeHost[],
): Promise<MultiHostUpgradeRecoverySnapshot> {
  return await replaceMultiHostUpgradeRecovery(
    runtimeRoot,
    {
      ...marker.recovery,
      hosts: hosts.map(markerHost),
    },
    marker.sha256,
  );
}

async function removeOldResources(
  host: UpgradeHost,
  runner: HostCommandRunner,
): Promise<void> {
  const assetChanges =
    host.candidateAssetTreeHash !== oldAsset(host.bound).installedTreeHash;
  if (host.bound.kind === "codex" && assetChanges) {
    await rollbackCodexPluginActivation(
      host.bound.bound.activationChange,
      runner,
    );
    host.oldActivationRemoved = true;
  }
  if (host.bound.kind === "claude") {
    await rollbackClaudePluginActivation(
      host.bound.bound.activationChange,
      runner,
    );
    host.oldActivationRemoved = true;
    await rollbackClaudeMarketplaceCatalog(host.bound.bound.catalogChange);
    host.oldCatalogRemoved = true;
  }
  if (assetChanges) {
    await rollbackHostAssetChange(oldAsset(host.bound));
    host.oldAssetRemoved = true;
  }
}

async function installCandidateResources(
  host: UpgradeHost,
  candidate: MaterializedRuntime,
  runner: HostCommandRunner,
): Promise<void> {
  if (host.oldAssetRemoved) {
    host.asset = await materializeHostAssets(host.plan, candidate);
    if (
      !host.asset.changed ||
      host.asset.installedTreeHash !== host.candidateAssetTreeHash
    ) {
      return conflict(`Candidate ${host.id} asset was not installed`);
    }
    host.newAssetInstalled = true;
  } else {
    host.asset = {
      ...oldAsset(host.bound),
      sourcePath: host.plan.mergeStrategy === "plugin-manifest"
        ? host.plan.pluginSourcePath!
        : host.plan.skillSourcePath,
    };
  }
  if (host.bound.kind === "codex" && host.oldActivationRemoved) {
    host.codexActivation = await applyCodexPluginActivation(
      host.bound.bound.registrationChange.marketplaceName,
      runner,
    );
    if (!host.codexActivation.changed) {
      return conflict("Candidate Codex activation was not installed");
    }
    host.newActivationInstalled = true;
  }
  if (host.bound.kind === "claude") {
    const pluginTarget = host.plan.pluginTargetPath;
    if (pluginTarget === undefined) {
      return conflict("Candidate Claude plugin target is missing");
    }
    host.catalog = await applyClaudeMarketplaceCatalog(
      createClaudeMarketplaceCatalogPlan(
        pluginTarget,
        candidate.pluginVersion,
      ),
    );
    if (
      !host.catalog.changed ||
      host.catalog.installedSha256 !== host.candidateCatalogSha256
    ) {
      return conflict("Candidate Claude catalog was not installed");
    }
    host.newCatalogInstalled = true;
    await verifyClaudeMarketplaceRegistration(
      host.bound.bound.registrationChange,
      runner,
    );
    host.claudeActivation = await applyClaudePluginActivation(
      host.catalog,
      host.bound.bound.registrationChange,
      runner,
    );
    if (!host.claudeActivation.changed) {
      return conflict("Candidate Claude activation was not installed");
    }
    host.newActivationInstalled = true;
  }
}

function completedHost(host: UpgradeHost): CompletedHostInstallation {
  switch (host.bound.kind) {
    case "codex":
      return {
        plan: host.plan,
        assetChange: host.asset,
        registrationChange: host.bound.bound.registrationChange,
        activationChange: host.codexActivation!,
      };
    case "claude":
      return {
        plan: host.plan,
        assetChange: host.asset,
        catalogChange: host.catalog!,
        registrationChange: host.bound.bound.registrationChange,
        activationChange: host.claudeActivation!,
      };
    case "config":
      return {
        plan: host.plan,
        configChange: host.bound.bound.configChange,
        assetChange: host.asset,
      };
  }
}

async function verifyCandidateHost(
  host: UpgradeHost,
  runner: HostCommandRunner,
): Promise<void> {
  await verifyHostAssetChange(host.asset);
  if (host.bound.kind === "codex") {
    await verifyCodexMarketplaceChange(host.bound.bound.registrationChange);
  }
  if (host.bound.kind === "claude") {
    await verifyClaudeMarketplaceCatalog(host.catalog!);
    await verifyClaudeMarketplaceRegistration(
      host.bound.bound.registrationChange,
      runner,
    );
  }
}

async function rollbackHosts(
  hosts: readonly UpgradeHost[],
  activeChange: AppliedActiveRuntimeChange | undefined,
  snapshot: InstallStateSnapshot,
  runtimeRoot: string,
  runner: HostCommandRunner,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const host of [...hosts].reverse()) {
    if (host.newActivationInstalled) {
      try {
        if (host.codexActivation !== undefined) {
          await rollbackCodexPluginActivation(host.codexActivation, runner);
        } else if (host.claudeActivation !== undefined) {
          await rollbackClaudePluginActivation(host.claudeActivation, runner);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (activeChange !== undefined && failures.length === 0) {
    try {
      await rollbackActiveRuntimeChange(activeChange);
    } catch (error) {
      failures.push(error);
    }
  }
  const restored = new Map<HostId, CompletedHostInstallation>();
  for (const host of [...hosts].reverse()) {
    if (failures.length > 0) break;
    try {
      if (host.newCatalogInstalled && host.catalog !== undefined) {
        await rollbackClaudeMarketplaceCatalog(host.catalog);
      }
      if (host.newAssetInstalled) {
        await rollbackHostAssetChange(host.asset);
      }
      let restoredAsset = oldAsset(host.bound);
      if (host.oldAssetRemoved) {
        restoredAsset = await materializeHostAssets(
          oldPlan(host.bound),
          oldRuntime(host.bound),
        );
        if (
          restoredAsset.installedTreeHash !==
          oldAsset(host.bound).installedTreeHash
        ) {
          return [new Error(`Restored ${host.id} asset digest changed`)];
        }
      }
      if (host.bound.kind === "codex") {
        let activation = host.bound.bound.activationChange;
        if (host.oldActivationRemoved) {
          activation = await applyCodexPluginActivation(
            host.bound.bound.registrationChange.marketplaceName,
            runner,
          );
        }
        restored.set(host.id, {
          plan: host.bound.bound.plan,
          assetChange: restoredAsset,
          registrationChange: host.bound.bound.registrationChange,
          activationChange: activation,
        });
      } else if (host.bound.kind === "claude") {
        let catalog = host.bound.bound.catalogChange;
        if (host.oldCatalogRemoved) {
          catalog = await applyClaudeMarketplaceCatalog(
            createClaudeMarketplaceCatalogPlan(
              host.bound.bound.assetChange.targetPath,
              host.bound.bound.runtime.pluginVersion,
            ),
          );
        }
        let activation = host.bound.bound.activationChange;
        if (host.oldActivationRemoved) {
          activation = await applyClaudePluginActivation(
            catalog,
            host.bound.bound.registrationChange,
            runner,
          );
        }
        restored.set(host.id, {
          plan: host.bound.bound.plan,
          assetChange: restoredAsset,
          catalogChange: catalog,
          registrationChange: host.bound.bound.registrationChange,
          activationChange: activation,
        });
      } else {
        restored.set(host.id, {
          plan: host.bound.bound.plan,
          configChange: host.bound.bound.configChange,
          assetChange: restoredAsset,
        });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0 && restored.size === hosts.length) {
    try {
      const completed = snapshot.state.hosts.map((entry) => restored.get(entry.id)!);
      const state = createInstallState(oldRuntime(hosts[0]!.bound), completed);
      if (installStateSha256(state) !== snapshot.sha256) {
        await replaceInstallState(runtimeRoot, state, snapshot.sha256);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function recoveryCandidateRuntime(
  runtimeRoot: string,
  stableLauncherPath: string,
  recovery: MultiHostUpgradeRecovery,
): Promise<MaterializedRuntime> {
  const versionDirectory = resolve(
    runtimeRoot,
    "versions",
    recovery.candidatePluginVersion,
  );
  const verified = await verifyInstallDirectory(
    versionDirectory,
    recovery.candidateInstallManifestSha256,
  );
  if (verified.manifest.pluginVersion !== recovery.candidatePluginVersion) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multi-host candidate runtime binding is invalid",
    );
  }
  return {
    pluginVersion: recovery.candidatePluginVersion,
    installManifestSha256: recovery.candidateInstallManifestSha256,
    runtimeRoot,
    versionDirectory,
    stableLauncherPath,
    activeRuntimePath: resolve(runtimeRoot, "current", "active-runtime.json"),
    nodePath: process.execPath,
    reusedVersion: true,
  };
}

function candidateAssetChange(
  host: UpgradeHost,
): AppliedHostAssetChange {
  return {
    hostId: host.id,
    kind: host.plan.mergeStrategy === "plugin-manifest" ? "plugin" : "skill",
    sourcePath: host.plan.mergeStrategy === "plugin-manifest"
      ? host.plan.pluginSourcePath!
      : host.plan.skillSourcePath,
    targetPath: oldAsset(host.bound).targetPath,
    changed: true,
    installedTreeHash: host.candidateAssetTreeHash,
    createdPaths: [oldAsset(host.bound).targetPath],
  };
}

function candidateCodexActivation(
  host: UpgradeHost,
  evidence: MultiHostUpgradeHostRecovery,
): AppliedCodexActivationChange | undefined {
  if (host.bound.kind !== "codex" || evidence.codexActivation === undefined) {
    return undefined;
  }
  return {
    kind: "codex-cli-plugin",
    executablePath: host.bound.bound.activationChange.executablePath,
    pluginId: evidence.codexActivation.pluginId,
    pluginName: "huaweicloud-mate",
    marketplaceName: host.bound.bound.activationChange.marketplaceName,
    version: evidence.codexActivation.version,
    installedEntryHash: evidence.codexActivation.installedEntryHash,
    changed: true,
    installed: true,
    enabled: true,
  };
}

function candidateClaudeActivation(
  host: UpgradeHost,
  evidence: MultiHostUpgradeHostRecovery,
): AppliedClaudeActivationChange | undefined {
  if (host.bound.kind !== "claude" || evidence.claudeActivation === undefined) {
    return undefined;
  }
  if (
    evidence.claudeActivation.pluginId !==
      "huaweicloud-mate@huaweicloud-mate-local"
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multi-host Claude activation identity is invalid",
    );
  }
  return {
    kind: "claude-cli-plugin",
    executablePath: host.bound.bound.activationChange.executablePath,
    pluginId: "huaweicloud-mate@huaweicloud-mate-local",
    pluginName: "huaweicloud-mate",
    marketplaceName: "huaweicloud-mate-local",
    version: evidence.claudeActivation.version,
    scope: "user",
    installPath: evidence.claudeActivation.installPath,
    installedEntryHash: evidence.claudeActivation.installedEntryHash,
    changed: true,
    installed: true,
    enabled: true,
  };
}

function candidateClaudeCatalog(
  host: UpgradeHost,
  candidate: MaterializedRuntime,
  evidence: MultiHostUpgradeHostRecovery,
): AppliedClaudeMarketplaceCatalogChange | undefined {
  if (
    host.bound.kind !== "claude" ||
    host.plan.pluginTargetPath === undefined ||
    evidence.candidateCatalogSha256 === undefined
  ) {
    return undefined;
  }
  const plan = createClaudeMarketplaceCatalogPlan(
    host.plan.pluginTargetPath,
    candidate.pluginVersion,
  );
  if (
    expectedClaudeMarketplaceCatalogSha256(plan) !==
    evidence.candidateCatalogSha256
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multi-host candidate Claude catalog digest is invalid",
    );
  }
  return {
    ...plan,
    changed: true,
    createdFile: true,
    installedSha256: evidence.candidateCatalogSha256,
    createdPaths: [plan.manifestPath],
  };
}

async function recoveryUpgradeHosts(
  snapshot: InstallStateSnapshot,
  recovery: MultiHostUpgradeRecovery,
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<{
  readonly hosts: UpgradeHost[];
  readonly candidate: MaterializedRuntime;
}> {
  const ids = snapshot.state.hosts.map((host) => host.id);
  if (
    ids.length !== recovery.hosts.length ||
    ids.some((id, index) => recovery.hosts[index]?.id !== id)
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multi-host recovery host set changed",
    );
  }
  const bound = await Promise.all(
    ids.map(async (id) => {
      const isolated = isolatedSnapshot(snapshot, id);
      switch (id) {
        case "codex": return {
          kind: "codex" as const,
          bound: await bindCodexInstallation({
            runtimeRoot,
            snapshot: isolated,
            runner,
            homeDirectory,
            requireExecutable: true,
          }),
        };
        case "claude": return {
          kind: "claude" as const,
          bound: await bindClaudeInstallation({
            runtimeRoot,
            snapshot: isolated,
            runner,
            homeDirectory,
            requireExecutable: true,
          }),
        };
        case "opencode":
        case "codearts": return {
          kind: "config" as const,
          bound: await bindConfigHostInstallation({
            host: id,
            runtimeRoot,
            snapshot: isolated,
            homeDirectory,
          }),
        };
      }
    }),
  );
  const candidate = await recoveryCandidateRuntime(
    runtimeRoot,
    oldRuntime(bound[0]!).stableLauncherPath,
    recovery,
  );
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(`${resolve(candidate.versionDirectory, "hosts", "templates")}${sep}`),
    pathToFileURL(`${resolve(candidate.versionDirectory, "contracts", "schema")}${sep}`),
  );
  const hosts: UpgradeHost[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const plan = createHostInstallPlan(
      registry.get(id),
      candidate,
      process.platform as "win32" | "darwin" | "linux",
      homeDirectory,
    );
    const host = await createUpgradeHost(
      id,
      bound[index]!,
      plan,
      candidate,
      runtimeRoot,
    );
    const evidence = recovery.hosts[index]!;
    if (
      host.candidateAssetTreeHash !== evidence.candidateAssetTreeHash ||
      host.candidateCatalogSha256 !== evidence.candidateCatalogSha256
    ) {
      throw new InstallerError(
        "UPGRADE_RECOVERY_CONFLICT",
        "Multi-host candidate evidence does not match the verified runtime",
      );
    }
    hosts.push(host);
  }
  return { hosts, candidate };
}

async function verifyCommittedMultiHostCandidate(
  snapshot: InstallStateSnapshot,
  recovery: MultiHostUpgradeRecovery,
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<void> {
  if (
    snapshot.state.pluginVersion !== recovery.candidatePluginVersion ||
    snapshot.state.installManifestSha256 !==
      recovery.candidateInstallManifestSha256 ||
    recovery.candidateActiveRuntimeSha256 === undefined
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Committed multi-host candidate state is invalid",
    );
  }
  const completed: CompletedHostInstallation[] = [];
  let runtime: MaterializedRuntime | undefined;
  for (let index = 0; index < snapshot.state.hosts.length; index += 1) {
    const id = snapshot.state.hosts[index]!.id;
    const bound = await bindHost(
      snapshot,
      id,
      runtimeRoot,
      homeDirectory,
      runner,
    );
    runtime ??= oldRuntime(bound);
    const evidence = recovery.hosts[index];
    if (
      evidence?.id !== id ||
      oldAsset(bound).installedTreeHash !== evidence.candidateAssetTreeHash
    ) {
      throw new InstallerError(
        "UPGRADE_RECOVERY_CONFLICT",
        "Committed multi-host asset evidence changed",
      );
    }
    switch (bound.kind) {
      case "codex":
        if (
          evidence.codexActivation === undefined ||
          bound.bound.activationChange.installedEntryHash !==
            evidence.codexActivation.installedEntryHash
        ) {
          return conflict("Committed Codex activation evidence changed");
        }
        completed.push({
          plan: bound.bound.plan,
          assetChange: bound.bound.assetChange,
          registrationChange: bound.bound.registrationChange,
          activationChange: bound.bound.activationChange,
        });
        break;
      case "claude":
        if (
          evidence.claudeActivation === undefined ||
          bound.bound.catalogChange.installedSha256 !==
            evidence.candidateCatalogSha256 ||
          bound.bound.activationChange.installedEntryHash !==
            evidence.claudeActivation.installedEntryHash
        ) {
          return conflict("Committed Claude activation evidence changed");
        }
        completed.push({
          plan: bound.bound.plan,
          assetChange: bound.bound.assetChange,
          catalogChange: bound.bound.catalogChange,
          registrationChange: bound.bound.registrationChange,
          activationChange: bound.bound.activationChange,
        });
        break;
      case "config":
        completed.push({
          plan: bound.bound.plan,
          configChange: bound.bound.configChange,
          assetChange: bound.bound.assetChange,
        });
        break;
    }
  }
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    active?.sha256 !== recovery.candidateActiveRuntimeSha256 ||
    active.pluginVersion !== recovery.candidatePluginVersion ||
    active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
    runtime === undefined
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Committed multi-host active runtime changed",
    );
  }
  await verifyInstalledHostBindings({ runtime, completedHosts: completed }, runner);
}

export async function recoverInterruptedMultiHostUpgrade(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<"absent" | "rolled-back" | "completed"> {
  const marker = await readMultiHostUpgradeRecovery(runtimeRoot);
  if (marker === undefined) return "absent";
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Multi-host recovery requires an install state",
    );
  }
  if (snapshot.sha256 !== marker.recovery.oldStateSha256) {
    await verifyCommittedMultiHostCandidate(
      snapshot,
      marker.recovery,
      runtimeRoot,
      homeDirectory,
      runner,
    );
    await removeMultiHostUpgradeRecovery(runtimeRoot, marker.sha256);
    return "completed";
  }
  if (
    snapshot.state.pluginVersion !== marker.recovery.oldPluginVersion ||
    snapshot.state.installManifestSha256 !==
      marker.recovery.oldInstallManifestSha256
  ) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Previous multi-host state changed during recovery",
    );
  }
  const { hosts, candidate } = await recoveryUpgradeHosts(
    snapshot,
    marker.recovery,
    runtimeRoot,
    homeDirectory,
    runner,
  );
  for (let index = 0; index < hosts.length; index += 1) {
    const host = hosts[index]!;
    const evidence = marker.recovery.hosts[index]!;
    if (
      host.candidateAssetTreeHash !== oldAsset(host.bound).installedTreeHash
    ) {
      try {
        host.oldAssetRemoved =
          (await inspectHostAssetRollback(oldAsset(host.bound))) === "removed";
      } catch {
        host.asset = candidateAssetChange(host);
        if ((await inspectHostAssetRollback(host.asset)) !== "installed") {
          return conflict(`Interrupted ${host.id} asset is not recoverable`);
        }
        host.oldAssetRemoved = true;
        host.newAssetInstalled = true;
      }
    }
    if (host.bound.kind === "codex" && host.oldAssetRemoved) {
      try {
        host.oldActivationRemoved =
          (await inspectCodexPluginActivationRollback(
            host.bound.bound.activationChange,
            runner,
          )) === "removed";
      } catch {
        const activation = candidateCodexActivation(host, evidence);
        if (
          activation === undefined ||
          (await inspectCodexPluginActivationRollback(activation, runner)) !==
            "installed"
        ) {
          return conflict("Interrupted Codex activation is not recoverable");
        }
        host.codexActivation = activation;
        host.oldActivationRemoved = true;
        host.newActivationInstalled = true;
      }
    }
    if (host.bound.kind === "claude") {
      try {
        host.oldActivationRemoved =
          (await inspectClaudePluginActivationRollback(
            host.bound.bound.activationChange,
            runner,
          )) === "removed";
      } catch {
        const activation = candidateClaudeActivation(host, evidence);
        if (
          activation === undefined ||
          (await inspectClaudePluginActivationRollback(activation, runner)) !==
            "installed"
        ) {
          return conflict("Interrupted Claude activation is not recoverable");
        }
        host.claudeActivation = activation;
        host.oldActivationRemoved = true;
        host.newActivationInstalled = true;
      }
      try {
        host.oldCatalogRemoved =
          (await inspectClaudeMarketplaceCatalogRollback(
            host.bound.bound.catalogChange,
          )) === "removed";
      } catch {
        const catalog = candidateClaudeCatalog(host, candidate, evidence);
        if (
          catalog === undefined ||
          (await inspectClaudeMarketplaceCatalogRollback(catalog)) !==
            "installed"
        ) {
          return conflict("Interrupted Claude catalog is not recoverable");
        }
        host.catalog = catalog;
        host.oldCatalogRemoved = true;
        host.newCatalogInstalled = true;
      }
    }
  }
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (active === undefined) {
    return conflict("Interrupted multi-host upgrade lost its active pointer");
  }
  if (active.sha256 !== marker.recovery.oldActiveRuntimeSha256) {
    const candidateActive =
      active.pluginVersion === marker.recovery.candidatePluginVersion &&
      active.installManifestSha256 ===
        marker.recovery.candidateInstallManifestSha256 &&
      (marker.recovery.candidateActiveRuntimeSha256 === undefined ||
        active.sha256 === marker.recovery.candidateActiveRuntimeSha256);
    if (!candidateActive) {
      return conflict("Interrupted multi-host active pointer drifted");
    }
    await activateMaterializedRuntime(oldRuntime(hosts[0]!.bound), active.sha256);
  }
  const failures = await rollbackHosts(
    hosts,
    undefined,
    snapshot,
    runtimeRoot,
    runner,
  );
  if (failures.length > 0) {
    throw new InstallerError(
      "UPGRADE_RECOVERY_CONFLICT",
      "Interrupted multi-host upgrade could not restore the old installation",
    );
  }
  await removeMultiHostUpgradeRecovery(runtimeRoot, marker.sha256);
  return "rolled-back";
}

export async function upgradeMultipleHosts(
  options: MultiHostUpgradeOptions,
): Promise<MultiHostUpgradeResult> {
  if (!isAbsolute(options.runtimeRoot)) {
    return invalid("Multi-host upgrade runtime root must be absolute");
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  const runner = options.runner ?? new NodeHostCommandRunner();
  await recoverInterruptedMultiHostUpgrade(runtimeRoot, homeDirectory, runner);
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined || snapshot.state.hosts.length < 2) {
    return invalid("Multi-host upgrade requires at least two managed hosts");
  }
  const activeBefore = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    activeBefore === undefined ||
    activeBefore.pluginVersion !== snapshot.state.pluginVersion ||
    activeBefore.installManifestSha256 !== snapshot.state.installManifestSha256
  ) {
    return conflict("Active runtime does not match the multi-host install state");
  }
  const candidate = await materializeRuntimeCandidate({
    ...(options.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: options.sourceDirectory }),
    runtimeRoot,
  });
  const ids = snapshot.state.hosts.map((host) => host.id);
  const boundHosts = await Promise.all(
    ids.map((id) => bindHost(snapshot, id, runtimeRoot, homeDirectory, runner)),
  );
  if (
    candidate.pluginVersion === snapshot.state.pluginVersion &&
    candidate.installManifestSha256 === snapshot.state.installManifestSha256
  ) {
    const completed = boundHosts.map((bound) => {
      switch (bound.kind) {
        case "codex": return {
          plan: bound.bound.plan,
          assetChange: bound.bound.assetChange,
          registrationChange: bound.bound.registrationChange,
          activationChange: bound.bound.activationChange,
        };
        case "claude": return {
          plan: bound.bound.plan,
          assetChange: bound.bound.assetChange,
          catalogChange: bound.bound.catalogChange,
          registrationChange: bound.bound.registrationChange,
          activationChange: bound.bound.activationChange,
        };
        case "config": return {
          plan: bound.bound.plan,
          configChange: bound.bound.configChange,
          assetChange: bound.bound.assetChange,
        };
      }
    });
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: oldRuntime(boundHosts[0]!), completedHosts: completed });
    return {
      status: "unchanged",
      changed: false,
      hosts: ids,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: snapshot.state.pluginVersion,
      runtimePath: snapshot.state.runtimePath,
    };
  }
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(`${resolve(candidate.versionDirectory, "hosts", "templates")}${sep}`),
    pathToFileURL(`${resolve(candidate.versionDirectory, "contracts", "schema")}${sep}`),
  );
  const hosts: UpgradeHost[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const plan = createHostInstallPlan(
      registry.get(id),
      candidate,
      process.platform as "win32" | "darwin" | "linux",
      homeDirectory,
    );
    hosts.push(await createUpgradeHost(
      id,
      boundHosts[index]!,
      plan,
      candidate,
      runtimeRoot,
    ));
  }
  let marker = await replaceMultiHostUpgradeRecovery(
    runtimeRoot,
    {
      schemaVersion: 1,
      oldStateSha256: snapshot.sha256,
      oldPluginVersion: snapshot.state.pluginVersion,
      oldInstallManifestSha256: snapshot.state.installManifestSha256,
      oldActiveRuntimeSha256: activeBefore.sha256,
      candidatePluginVersion: candidate.pluginVersion,
      candidateInstallManifestSha256: candidate.installManifestSha256,
      hosts: hosts.map(markerHost),
    },
    null,
  );
  let activeChange: AppliedActiveRuntimeChange | undefined;
  try {
    for (const host of hosts) {
      await removeOldResources(host, runner);
      await installCandidateResources(host, candidate, runner);
      if (host.newActivationInstalled) {
        marker = await refreshMarker(runtimeRoot, marker, hosts);
      }
      await verifyCandidateHost(host, runner);
    }
    activeChange = await activateMaterializedRuntime(candidate, activeBefore.sha256);
    if (!activeChange.changed) {
      return conflict("Candidate active runtime did not change");
    }
    marker = await replaceMultiHostUpgradeRecovery(
      runtimeRoot,
      {
        ...marker.recovery,
        candidateActiveRuntimeSha256: activeChange.installedSha256,
      },
      marker.sha256,
    );
    const completed = hosts.map(completedHost);
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: candidate, completedHosts: completed });
    const state = createInstallState(candidate, completed);
    await replaceInstallState(runtimeRoot, state, snapshot.sha256);
    try {
      await removeMultiHostUpgradeRecovery(runtimeRoot, marker.sha256);
    } catch {
      // install-state is the final commit; a verified stale marker is recovered later.
    }
    return {
      status: "upgraded",
      changed: true,
      hosts: ids,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: candidate.pluginVersion,
      runtimePath: candidate.versionDirectory,
    };
  } catch (error) {
    const failures = [...await rollbackHosts(
      hosts,
      activeChange,
      snapshot,
      runtimeRoot,
      runner,
    )];
    if (failures.length === 0) {
      try {
        await removeMultiHostUpgradeRecovery(runtimeRoot, marker.sha256);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length > 0) {
      throw new InstallerError(
        "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
        "Multi-host upgrade failed and the previous installation could not be fully restored",
      );
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "UPGRADE_TRANSACTION_FAILED",
      "Multi-host managed upgrade failed",
    );
  }
}
