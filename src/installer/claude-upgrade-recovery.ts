import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { createHostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  applyClaudePluginActivation,
  discoverClaudePluginActivation,
  inspectClaudePluginActivationRollback,
  rollbackClaudePluginActivation,
  verifyClaudePluginActivation,
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
  readClaudeUpgradeRecovery,
  removeClaudeUpgradeRecovery,
  replaceClaudeUpgradeRecovery,
  type ClaudeUpgradeRecovery,
  type ClaudeUpgradeRecoverySnapshot,
} from "./claude-upgrade-recovery-state.js";
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
} from "./install-state.js";
import {
  activateMaterializedRuntime,
  readActiveRuntimeSnapshot,
  type MaterializedRuntime,
} from "./runtime.js";

export type ClaudeUpgradeRecoveryResult = "absent" | "rolled-back" | "completed";

function conflict(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_CONFLICT", message);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function candidateRuntime(
  runtimeRoot: string,
  recovery: ClaudeUpgradeRecovery,
  stableLauncherPath: string,
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
    return conflict("Claude recovery candidate runtime version is invalid");
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

async function candidatePlan(runtime: MaterializedRuntime, homeDirectory: string) {
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(
      `${resolve(runtime.versionDirectory, "hosts", "templates")}${sep}`,
    ),
    pathToFileURL(
      `${resolve(runtime.versionDirectory, "contracts", "schema")}${sep}`,
    ),
  );
  return createHostInstallPlan(
    registry.get("claude"),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    homeDirectory,
  );
}

function candidateCatalog(
  bound: BoundClaudeInstallation,
  runtime: MaterializedRuntime,
  recovery: ClaudeUpgradeRecovery,
): AppliedClaudeMarketplaceCatalogChange {
  const plan = createClaudeMarketplaceCatalogPlan(
    bound.assetChange.targetPath,
    runtime.pluginVersion,
  );
  if (
    expectedClaudeMarketplaceCatalogSha256(plan) !==
    recovery.candidateCatalogSha256
  ) {
    return conflict("Claude recovery candidate catalog digest is invalid");
  }
  return {
    ...plan,
    changed: true,
    createdFile: true,
    installedSha256: recovery.candidateCatalogSha256,
    createdPaths: [plan.manifestPath],
  };
}

function recordedCandidateActivation(
  bound: BoundClaudeInstallation,
  recovery: ClaudeUpgradeRecovery,
): AppliedClaudeActivationChange | undefined {
  const evidence = recovery.candidateActivation;
  if (evidence === undefined) return undefined;
  return {
    kind: "claude-cli-plugin",
    executablePath: bound.activationChange.executablePath,
    pluginId: evidence.pluginId,
    pluginName: "huaweicloud-mate",
    marketplaceName: "huaweicloud-mate-local",
    version: evidence.version,
    scope: "user",
    installPath: evidence.installPath,
    installedEntryHash: evidence.installedEntryHash,
    changed: true,
    installed: true,
    enabled: true,
  };
}

function recordedRestoredActivation(
  bound: BoundClaudeInstallation,
  recovery: ClaudeUpgradeRecovery,
): AppliedClaudeActivationChange | undefined {
  const evidence = recovery.restoredActivation;
  if (evidence === undefined) return undefined;
  return {
    kind: "claude-cli-plugin",
    executablePath: bound.activationChange.executablePath,
    pluginId: evidence.pluginId,
    pluginName: "huaweicloud-mate",
    marketplaceName: "huaweicloud-mate-local",
    version: evidence.version,
    scope: "user",
    installPath: evidence.installPath,
    installedEntryHash: evidence.installedEntryHash,
    changed: true,
    installed: true,
    enabled: true,
  };
}

async function removeCandidateActivationIfPresent(
  runtimeRoot: string,
  bound: BoundClaudeInstallation,
  marker: ClaudeUpgradeRecoverySnapshot,
  runner: HostCommandRunner,
): Promise<{
  readonly oldRemoved: boolean;
  readonly marker: ClaudeUpgradeRecoverySnapshot;
  readonly currentOldActivation?: AppliedClaudeActivationChange;
}> {
  try {
    const status = await inspectClaudePluginActivationRollback(
      bound.activationChange,
      runner,
    );
    return {
      oldRemoved: status === "removed",
      marker,
      ...(status === "installed"
        ? { currentOldActivation: bound.activationChange }
        : {}),
    };
  } catch {
    const recordedRestored = recordedRestoredActivation(
      bound,
      marker.recovery,
    );
    if (recordedRestored !== undefined) {
      try {
        if (
          (await inspectClaudePluginActivationRollback(
            recordedRestored,
            runner,
          )) === "installed"
        ) {
          return {
            oldRemoved: false,
            marker,
            currentOldActivation: recordedRestored,
          };
        }
      } catch {
        // Continue by checking the candidate identity.
      }
    }
    try {
      const discoveredOld = await discoverClaudePluginActivation(
        bound.activationChange.executablePath,
        marker.recovery.oldPluginVersion,
        runner,
      );
      if (discoveredOld !== undefined) {
        marker = await replaceClaudeUpgradeRecovery(
          runtimeRoot,
          {
            ...marker.recovery,
            restoredActivation: {
              pluginId: discoveredOld.pluginId,
              version: discoveredOld.version,
              installPath: discoveredOld.installPath,
              installedEntryHash: discoveredOld.installedEntryHash,
            },
          },
          marker.sha256,
        );
        return {
          oldRemoved: false,
          marker,
          currentOldActivation: discoveredOld,
        };
      }
    } catch {
      // A candidate version causes the old-version parser to fail closed.
    }
    let candidate = recordedCandidateActivation(bound, marker.recovery);
    if (candidate === undefined) {
      try {
        candidate = await discoverClaudePluginActivation(
          bound.activationChange.executablePath,
          marker.recovery.candidatePluginVersion,
          runner,
        );
      } catch {
        return conflict(
          "Claude activation is neither the previous nor discoverable candidate entry",
        );
      }
      if (candidate === undefined) {
        return conflict("Claude candidate activation evidence is missing");
      }
      marker = await replaceClaudeUpgradeRecovery(
        runtimeRoot,
        {
          ...marker.recovery,
          candidateActivation: {
            pluginId: candidate.pluginId,
            version: candidate.version,
            installPath: candidate.installPath,
            installedEntryHash: candidate.installedEntryHash,
          },
        },
        marker.sha256,
      );
    }
    try {
      if (
        (await inspectClaudePluginActivationRollback(candidate, runner)) !==
        "installed"
      ) {
        return conflict("Recorded Claude candidate activation is not installed");
      }
      await rollbackClaudePluginActivation(candidate, runner);
      return { oldRemoved: true, marker };
    } catch (error) {
      if (
        error instanceof InstallerError &&
        error.code === "UPGRADE_RECOVERY_CONFLICT"
      ) {
        throw error;
      }
      return conflict("Recorded Claude candidate activation could not be removed");
    }
  }
}

async function restoreOldPointer(
  runtimeRoot: string,
  bound: BoundClaudeInstallation,
  recovery: ClaudeUpgradeRecovery,
): Promise<void> {
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (active === undefined) {
    return conflict("Active runtime pointer is missing during Claude recovery");
  }
  if (
    active.pluginVersion === recovery.oldPluginVersion &&
    active.installManifestSha256 === recovery.oldInstallManifestSha256
  ) {
    if (active.sha256 !== recovery.oldActiveRuntimeSha256) {
      return conflict("Previous active runtime pointer bytes changed");
    }
    return;
  }
  if (
    active.pluginVersion !== recovery.candidatePluginVersion ||
    active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
    (recovery.candidateActiveRuntimeSha256 !== undefined &&
      active.sha256 !== recovery.candidateActiveRuntimeSha256)
  ) {
    return conflict("Active runtime is neither the previous nor candidate version");
  }
  const restored = await activateMaterializedRuntime(bound.runtime, active.sha256);
  if (
    !restored.changed ||
    restored.installedSha256 !== recovery.oldActiveRuntimeSha256
  ) {
    return conflict("Previous active runtime pointer could not be restored exactly");
  }
}

async function removeCandidateCatalogIfPresent(
  bound: BoundClaudeInstallation,
  candidate: AppliedClaudeMarketplaceCatalogChange,
): Promise<boolean> {
  try {
    const status = await inspectClaudeMarketplaceCatalogRollback(
      bound.catalogChange,
    );
    return status === "removed";
  } catch {
    try {
      if (
        (await inspectClaudeMarketplaceCatalogRollback(candidate)) !==
        "installed"
      ) {
        return conflict("Recorded Claude candidate catalog is not installed");
      }
      await rollbackClaudeMarketplaceCatalog(candidate);
      return true;
    } catch (error) {
      if (
        error instanceof InstallerError &&
        error.code === "UPGRADE_RECOVERY_CONFLICT"
      ) {
        throw error;
      }
      return conflict("Recorded Claude candidate catalog could not be removed");
    }
  }
}

async function removeCandidateAssetIfPresent(
  bound: BoundClaudeInstallation,
  plan: Awaited<ReturnType<typeof candidatePlan>>,
  runtime: MaterializedRuntime,
  recovery: ClaudeUpgradeRecovery,
): Promise<boolean> {
  try {
    const status = await inspectHostAssetRollback(bound.assetChange);
    return status === "removed";
  } catch {
    if (
      plan.pluginSourcePath === undefined ||
      plan.pluginTargetPath === undefined ||
      !samePath(plan.pluginTargetPath, bound.assetChange.targetPath) ||
      !samePath(plan.configPath, bound.plan.configPath) ||
      (await expectedHostAssetTreeHash(plan, runtime)) !==
        recovery.candidateAssetTreeHash
    ) {
      return conflict("Claude recovery candidate changes the fixed asset plan");
    }
    const candidate: AppliedHostAssetChange = {
      hostId: "claude",
      kind: "plugin",
      sourcePath: plan.pluginSourcePath,
      targetPath: plan.pluginTargetPath,
      changed: true,
      installedTreeHash: recovery.candidateAssetTreeHash,
      createdPaths: [plan.pluginTargetPath],
    };
    try {
      if ((await inspectHostAssetRollback(candidate)) !== "installed") {
        return conflict("Recorded Claude candidate asset is not installed");
      }
      await rollbackHostAssetChange(candidate);
      return true;
    } catch (error) {
      if (
        error instanceof InstallerError &&
        error.code === "UPGRADE_RECOVERY_CONFLICT"
      ) {
        throw error;
      }
      return conflict("Recorded Claude candidate asset could not be removed");
    }
  }
}

async function verifyCommittedCandidate(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
  recovery: ClaudeUpgradeRecovery,
): Promise<void> {
  const snapshot = await readInstallState(runtimeRoot);
  if (
    snapshot === undefined ||
    snapshot.state.pluginVersion !== recovery.candidatePluginVersion ||
    snapshot.state.installManifestSha256 !==
      recovery.candidateInstallManifestSha256
  ) {
    return conflict("Claude install state is not the committed candidate");
  }
  const bound = await bindClaudeInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  const activation = recovery.candidateActivation;
  if (
    !bound.assetChange.changed ||
    bound.assetChange.installedTreeHash !== recovery.candidateAssetTreeHash ||
    !bound.catalogChange.changed ||
    bound.catalogChange.installedSha256 !== recovery.candidateCatalogSha256 ||
    !bound.activationChange.changed ||
    activation === undefined ||
    bound.activationChange.pluginId !== activation.pluginId ||
    bound.activationChange.version !== activation.version ||
    !samePath(bound.activationChange.installPath, activation.installPath) ||
    bound.activationChange.installedEntryHash !== activation.installedEntryHash
  ) {
    return conflict("Committed Claude candidate does not match recovery evidence");
  }
  await inspectBoundClaudeInstallation(bound, runner);
  await verifyBoundClaudeInstallation(bound, runner);
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    active === undefined ||
    active.pluginVersion !== recovery.candidatePluginVersion ||
    active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
    (recovery.candidateActiveRuntimeSha256 !== undefined &&
      active.sha256 !== recovery.candidateActiveRuntimeSha256)
  ) {
    return conflict("Committed Claude candidate active runtime is invalid");
  }
}

async function verifyRestoredState(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
  recovery: ClaudeUpgradeRecovery,
): Promise<void> {
  const snapshot = await readInstallState(runtimeRoot);
  if (
    snapshot === undefined ||
    snapshot.sha256 !== recovery.restoredStateSha256 ||
    snapshot.state.pluginVersion !== recovery.oldPluginVersion ||
    snapshot.state.installManifestSha256 !== recovery.oldInstallManifestSha256
  ) {
    return conflict("Restored Claude install state is invalid");
  }
  const bound = await bindClaudeInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  await inspectBoundClaudeInstallation(bound, runner);
  await verifyBoundClaudeInstallation(bound, runner);
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (active?.sha256 !== recovery.oldActiveRuntimeSha256) {
    return conflict("Restored Claude active runtime is invalid");
  }
}

export async function recoverInterruptedClaudeUpgrade(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<ClaudeUpgradeRecoveryResult> {
  let marker = await readClaudeUpgradeRecovery(runtimeRoot);
  if (marker === undefined) return "absent";
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    return conflict("Claude upgrade recovery requires an install state");
  }
  if (snapshot.sha256 !== marker.recovery.oldStateSha256) {
    if (snapshot.sha256 === marker.recovery.restoredStateSha256) {
      await verifyRestoredState(
        runtimeRoot,
        homeDirectory,
        runner,
        marker.recovery,
      );
      await removeClaudeUpgradeRecovery(runtimeRoot, marker.sha256);
      return "rolled-back";
    }
    await verifyCommittedCandidate(
      runtimeRoot,
      homeDirectory,
      runner,
      marker.recovery,
    );
    await removeClaudeUpgradeRecovery(runtimeRoot, marker.sha256);
    return "completed";
  }
  if (
    snapshot.state.pluginVersion !== marker.recovery.oldPluginVersion ||
    snapshot.state.installManifestSha256 !==
      marker.recovery.oldInstallManifestSha256
  ) {
    return conflict("Previous Claude install state does not match recovery marker");
  }
  const bound = await bindClaudeInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  if (
    !bound.assetChange.changed ||
    !bound.catalogChange.changed ||
    !bound.activationChange.changed
  ) {
    return conflict("Claude recovery cannot own a pre-existing dependency");
  }
  await verifyClaudeMarketplaceRegistration(bound.registrationChange, runner);
  const runtime = await candidateRuntime(
    runtimeRoot,
    marker.recovery,
    bound.runtime.stableLauncherPath,
  );
  const plan = await candidatePlan(runtime, homeDirectory);
  if (
    plan.pluginSourcePath === undefined ||
    plan.pluginTargetPath === undefined ||
    !samePath(plan.pluginTargetPath, bound.assetChange.targetPath) ||
    !samePath(plan.configPath, bound.plan.configPath) ||
    (await expectedHostAssetTreeHash(plan, runtime)) !==
      marker.recovery.candidateAssetTreeHash
  ) {
    return conflict("Claude recovery candidate does not match the fixed plan");
  }
  const candidateCatalogChange = candidateCatalog(
    bound,
    runtime,
    marker.recovery,
  );

  const activation = await removeCandidateActivationIfPresent(
    runtimeRoot,
    bound,
    marker,
    runner,
  );
  marker = activation.marker;
  await restoreOldPointer(runtimeRoot, bound, marker.recovery);
  const oldCatalogRemoved = await removeCandidateCatalogIfPresent(
    bound,
    candidateCatalogChange,
  );
  const oldAssetRemoved = await removeCandidateAssetIfPresent(
    bound,
    plan,
    runtime,
    marker.recovery,
  );

  let restoredAsset = bound.assetChange;
  if (oldAssetRemoved) {
    restoredAsset = await materializeHostAssets(bound.plan, bound.runtime);
    if (restoredAsset.installedTreeHash !== bound.assetChange.installedTreeHash) {
      return conflict("Previous Claude asset could not be restored exactly");
    }
  }
  let restoredCatalog = bound.catalogChange;
  if (oldCatalogRemoved) {
    restoredCatalog = await applyClaudeMarketplaceCatalog(
      createClaudeMarketplaceCatalogPlan(
        bound.assetChange.targetPath,
        bound.runtime.pluginVersion,
      ),
    );
    if (
      restoredCatalog.installedSha256 !== bound.catalogChange.installedSha256
    ) {
      return conflict("Previous Claude catalog could not be restored exactly");
    }
  }
  let restoredActivation =
    activation.currentOldActivation ?? bound.activationChange;
  if (activation.oldRemoved) {
    restoredActivation = await applyClaudePluginActivation(
      restoredCatalog,
      bound.registrationChange,
      runner,
    );
    if (restoredActivation.version !== bound.activationChange.version) {
      return conflict("Previous Claude activation restored the wrong version");
    }
  }

  await verifyHostAssetChange(restoredAsset);
  await verifyClaudeMarketplaceCatalog(restoredCatalog);
  await verifyClaudeMarketplaceRegistration(bound.registrationChange, runner);
  await verifyClaudePluginActivation(restoredActivation, runner);
  const completed: CompletedHostInstallation = {
    plan: bound.plan,
    assetChange: restoredAsset,
    catalogChange: restoredCatalog,
    registrationChange: bound.registrationChange,
    activationChange: restoredActivation,
  };
  const restoredState = createInstallState(bound.runtime, [completed]);
  const restoredStateSha256 = installStateSha256(restoredState);
  marker = await replaceClaudeUpgradeRecovery(
    runtimeRoot,
    {
      ...marker.recovery,
      restoredActivation: {
        pluginId: restoredActivation.pluginId,
        version: restoredActivation.version,
        installPath: restoredActivation.installPath,
        installedEntryHash: restoredActivation.installedEntryHash,
      },
      restoredStateSha256,
    },
    marker.sha256,
  );
  const stateChange = await replaceInstallState(
    runtimeRoot,
    restoredState,
    snapshot.sha256,
  );
  if (stateChange.installedSha256 !== restoredStateSha256) {
    return conflict("Restored Claude install state digest changed during commit");
  }
  await removeClaudeUpgradeRecovery(runtimeRoot, marker.sha256);
  return "rolled-back";
}
