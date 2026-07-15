import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { createHostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import { createInitialHostVerificationHook } from "../hosts/verification.js";
import {
  applyClaudePluginActivation,
  rollbackClaudePluginActivation,
  type AppliedClaudeActivationChange,
} from "./claude-activation.js";
import {
  bindClaudeInstallation,
  inspectBoundClaudeInstallation,
  verifyBoundClaudeInstallation,
} from "./claude-installation.js";
import {
  applyClaudeMarketplaceCatalog,
  createClaudeMarketplaceCatalogPlan,
  expectedClaudeMarketplaceCatalogSha256,
  rollbackClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
  type AppliedClaudeMarketplaceCatalogChange,
} from "./claude-marketplace.js";
import { recoverInterruptedClaudeUpgrade } from "./claude-upgrade-recovery.js";
import {
  removeClaudeUpgradeRecovery,
  replaceClaudeUpgradeRecovery,
  type ClaudeUpgradeRecoverySnapshot,
} from "./claude-upgrade-recovery-state.js";
import { InstallerError } from "./errors.js";
import {
  expectedHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
  type AppliedHostAssetChange,
} from "./host-assets.js";
import {
  createInstallState,
  installStateSha256,
  readInstallState,
  replaceInstallState,
  type CompletedHostInstallation,
} from "./install-state.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
  rollbackActiveRuntimeChange,
  type AppliedActiveRuntimeChange,
} from "./runtime.js";

export interface ClaudeUpgradeOptions {
  readonly runtimeRoot: string;
  readonly sourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe: () => Promise<void>;
}

export interface ClaudeUpgradeResult {
  readonly host: "claude";
  readonly status: "unchanged" | "upgraded";
  readonly changed: boolean;
  readonly previousVersion: string;
  readonly pluginVersion: string;
  readonly runtimePath: string;
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

async function candidatePlan(
  runtime: Awaited<ReturnType<typeof materializeRuntimeCandidate>>,
  homeDirectory: string,
) {
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

export async function upgradeClaude(
  options: ClaudeUpgradeOptions,
): Promise<ClaudeUpgradeResult> {
  if (!isAbsolute(options.runtimeRoot)) {
    return invalid("Managed Claude upgrade runtime root must be absolute");
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  const runner = options.runner ?? new NodeHostCommandRunner();
  const homeDirectory = options.homeDirectory ?? homedir();
  await recoverInterruptedClaudeUpgrade(runtimeRoot, homeDirectory, runner);
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    return invalid("Managed Claude upgrade requires an existing install state");
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
  const activeBefore = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    activeBefore === undefined ||
    activeBefore.pluginVersion !== snapshot.state.pluginVersion ||
    activeBefore.installManifestSha256 !==
      snapshot.state.installManifestSha256
  ) {
    return conflict("Active runtime does not match the managed install state");
  }

  const candidate = await materializeRuntimeCandidate({
    ...(options.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: options.sourceDirectory }),
    runtimeRoot,
  });
  const plan = await candidatePlan(candidate, homeDirectory);
  if (
    plan.pluginTargetPath === undefined ||
    plan.pluginSourcePath === undefined ||
    !samePath(plan.pluginTargetPath, bound.assetChange.targetPath) ||
    !samePath(plan.configPath, bound.plan.configPath)
  ) {
    return conflict("Candidate Claude plan changes a fixed managed path");
  }

  if (
    candidate.pluginVersion === snapshot.state.pluginVersion &&
    candidate.installManifestSha256 === snapshot.state.installManifestSha256
  ) {
    const completed: CompletedHostInstallation = {
      plan: bound.plan,
      assetChange: bound.assetChange,
      catalogChange: bound.catalogChange,
      registrationChange: bound.registrationChange,
      activationChange: bound.activationChange,
    };
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: bound.runtime, completedHosts: [completed] });
    return {
      host: "claude",
      status: "unchanged",
      changed: false,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: snapshot.state.pluginVersion,
      runtimePath: snapshot.state.runtimePath,
    };
  }
  if (
    !bound.assetChange.changed ||
    !bound.catalogChange.changed ||
    !bound.activationChange.changed
  ) {
    return conflict(
      "Managed upgrade cannot replace a Claude asset, catalog, or activation that predated installation",
    );
  }

  const candidateAssetTreeHash = await expectedHostAssetTreeHash(
    plan,
    candidate,
  );
  const candidateCatalogPlan = createClaudeMarketplaceCatalogPlan(
    plan.pluginTargetPath,
    candidate.pluginVersion,
  );
  const candidateCatalogSha256 =
    expectedClaudeMarketplaceCatalogSha256(candidateCatalogPlan);
  let recoverySnapshot: ClaudeUpgradeRecoverySnapshot =
    await replaceClaudeUpgradeRecovery(
      runtimeRoot,
      {
        schemaVersion: 1,
        host: "claude",
        oldStateSha256: snapshot.sha256,
        oldPluginVersion: snapshot.state.pluginVersion,
        oldInstallManifestSha256: snapshot.state.installManifestSha256,
        oldActiveRuntimeSha256: activeBefore.sha256,
        candidatePluginVersion: candidate.pluginVersion,
        candidateInstallManifestSha256: candidate.installManifestSha256,
        candidateAssetTreeHash,
        candidateCatalogSha256,
      },
      null,
    );

  let oldActivationRemoved = false;
  let oldCatalogRemoved = false;
  let oldAssetRemoved = false;
  let newAsset: AppliedHostAssetChange | undefined;
  let newCatalog: AppliedClaudeMarketplaceCatalogChange | undefined;
  let newActivation: AppliedClaudeActivationChange | undefined;
  let activeChange: AppliedActiveRuntimeChange | undefined;
  try {
    await rollbackClaudePluginActivation(bound.activationChange, runner);
    oldActivationRemoved = true;
    await rollbackClaudeMarketplaceCatalog(bound.catalogChange);
    oldCatalogRemoved = true;
    await rollbackHostAssetChange(bound.assetChange);
    oldAssetRemoved = true;

    newAsset = await materializeHostAssets(plan, candidate);
    if (!newAsset.changed) {
      return conflict("Candidate Claude asset was not installed by the upgrade");
    }
    newCatalog = await applyClaudeMarketplaceCatalog(candidateCatalogPlan);
    if (!newCatalog.changed) {
      return conflict("Candidate Claude catalog was not installed by the upgrade");
    }
    await verifyClaudeMarketplaceRegistration(bound.registrationChange, runner);
    newActivation = await applyClaudePluginActivation(
      newCatalog,
      bound.registrationChange,
      runner,
    );
    if (!newActivation.changed) {
      return conflict("Candidate Claude activation was not installed by the upgrade");
    }
    recoverySnapshot = await replaceClaudeUpgradeRecovery(
      runtimeRoot,
      {
        ...recoverySnapshot.recovery,
        candidateActivation: {
          pluginId: newActivation.pluginId,
          version: newActivation.version,
          installPath: newActivation.installPath,
          installedEntryHash: newActivation.installedEntryHash,
        },
      },
      recoverySnapshot.sha256,
    );
    await verifyHostAssetChange(newAsset);
    await verifyClaudeMarketplaceCatalog(newCatalog);

    activeChange = await activateMaterializedRuntime(candidate, activeBefore.sha256);
    if (!activeChange.changed) {
      return conflict("Candidate active runtime did not change during upgrade");
    }
    recoverySnapshot = await replaceClaudeUpgradeRecovery(
      runtimeRoot,
      {
        ...recoverySnapshot.recovery,
        candidateActiveRuntimeSha256: activeChange.installedSha256,
      },
      recoverySnapshot.sha256,
    );
    const completed: CompletedHostInstallation = {
      plan,
      assetChange: newAsset,
      catalogChange: newCatalog,
      registrationChange: bound.registrationChange,
      activationChange: newActivation,
    };
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: candidate, completedHosts: [completed] });
    const state = createInstallState(candidate, [completed]);
    await replaceInstallState(runtimeRoot, state, snapshot.sha256);
    try {
      await removeClaudeUpgradeRecovery(runtimeRoot, recoverySnapshot.sha256);
    } catch {
      // install-state is the final commit; a verified stale marker is removed on retry.
    }
    return {
      host: "claude",
      status: "upgraded",
      changed: true,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: candidate.pluginVersion,
      runtimePath: candidate.versionDirectory,
    };
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    let canRestoreOldDependencies = !(
      error instanceof InstallerError &&
      error.code === "CLAUDE_ACTIVATION_OUTCOME_UNKNOWN"
    );
    if (!canRestoreOldDependencies) {
      rollbackFailures.push(error);
    }
    if (newActivation !== undefined) {
      try {
        await rollbackClaudePluginActivation(newActivation, runner);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (activeChange !== undefined && canRestoreOldDependencies) {
      try {
        await rollbackActiveRuntimeChange(activeChange);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (newCatalog !== undefined && canRestoreOldDependencies) {
      try {
        await rollbackClaudeMarketplaceCatalog(newCatalog);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (newAsset !== undefined && canRestoreOldDependencies) {
      try {
        await rollbackHostAssetChange(newAsset);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }

    let restoredAsset: AppliedHostAssetChange | undefined;
    let restoredCatalog: AppliedClaudeMarketplaceCatalogChange | undefined;
    let restoredActivation: AppliedClaudeActivationChange | undefined;
    if (oldAssetRemoved && canRestoreOldDependencies) {
      try {
        restoredAsset = await materializeHostAssets(bound.plan, bound.runtime);
        if (
          restoredAsset.installedTreeHash !==
          bound.assetChange.installedTreeHash
        ) {
          throw new InstallerError(
            "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
            "Restored Claude asset does not match the previous version",
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (oldCatalogRemoved && canRestoreOldDependencies) {
      try {
        restoredCatalog = await applyClaudeMarketplaceCatalog(
          createClaudeMarketplaceCatalogPlan(
            bound.assetChange.targetPath,
            bound.runtime.pluginVersion,
          ),
        );
        if (
          restoredCatalog.installedSha256 !==
          bound.catalogChange.installedSha256
        ) {
          throw new InstallerError(
            "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
            "Restored Claude catalog does not match the previous version",
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (oldActivationRemoved && canRestoreOldDependencies) {
      try {
        const catalog = restoredCatalog ?? bound.catalogChange;
        restoredActivation = await applyClaudePluginActivation(
          catalog,
          bound.registrationChange,
          runner,
        );
        if (restoredActivation.version !== bound.activationChange.version) {
          throw new InstallerError(
            "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
            "Restored Claude activation has the wrong version",
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (
      canRestoreOldDependencies &&
      (restoredAsset !== undefined ||
        restoredCatalog !== undefined ||
        restoredActivation !== undefined)
    ) {
      try {
        const restored: CompletedHostInstallation = {
          plan: bound.plan,
          assetChange: restoredAsset ?? bound.assetChange,
          catalogChange: restoredCatalog ?? bound.catalogChange,
          registrationChange: bound.registrationChange,
          activationChange: restoredActivation ?? bound.activationChange,
        };
        const restoredState = createInstallState(bound.runtime, [restored]);
        const restoredStateSha256 = installStateSha256(restoredState);
        const finalActivation = restoredActivation ?? bound.activationChange;
        recoverySnapshot = await replaceClaudeUpgradeRecovery(
          runtimeRoot,
          {
            ...recoverySnapshot.recovery,
            restoredActivation: {
              pluginId: finalActivation.pluginId,
              version: finalActivation.version,
              installPath: finalActivation.installPath,
              installedEntryHash: finalActivation.installedEntryHash,
            },
            restoredStateSha256,
          },
          recoverySnapshot.sha256,
        );
        const stateChange = await replaceInstallState(
          runtimeRoot,
          restoredState,
          snapshot.sha256,
        );
        if (stateChange.installedSha256 !== restoredStateSha256) {
          throw new InstallerError(
            "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
            "Restored Claude install state digest changed during commit",
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length === 0) {
      try {
        await removeClaudeUpgradeRecovery(
          runtimeRoot,
          recoverySnapshot.sha256,
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new InstallerError(
        "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
        "Claude upgrade failed and the previous installation could not be fully restored",
      );
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UPGRADE_TRANSACTION_FAILED",
      "Claude managed upgrade failed",
    );
  }
}
