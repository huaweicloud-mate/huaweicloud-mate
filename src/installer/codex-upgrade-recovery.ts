import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { createHostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  applyCodexPluginActivation,
  inspectCodexPluginActivationRollback,
  rollbackCodexPluginActivation,
  verifyCodexPluginActivation,
  type AppliedCodexActivationChange,
} from "./codex-activation.js";
import {
  bindCodexInstallation,
  inspectBoundCodexInstallation,
  verifyBoundCodexInstallation,
  type BoundCodexInstallation,
} from "./codex-installation.js";
import { verifyCodexMarketplaceChange } from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import {
  expectedHostAssetTreeHash,
  inspectHostAssetRollback,
  materializeHostAssets,
  rollbackHostAssetChange,
  type AppliedHostAssetChange,
} from "./host-assets.js";
import { verifyInstallDirectory } from "./install-manifest.js";
import { readInstallState } from "./install-state.js";
import {
  activateMaterializedRuntime,
  readActiveRuntimeSnapshot,
  type MaterializedRuntime,
} from "./runtime.js";
import {
  readCodexUpgradeRecovery,
  removeCodexUpgradeRecovery,
  type CodexUpgradeRecovery,
} from "./upgrade-recovery.js";

export type CodexUpgradeRecoveryResult = "absent" | "rolled-back" | "completed";

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
  recovery: CodexUpgradeRecovery,
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
    return conflict("Recovery candidate runtime version is invalid");
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
    registry.get("codex"),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    homeDirectory,
  );
}

function candidateActivation(
  recovery: CodexUpgradeRecovery,
  old: AppliedCodexActivationChange,
): AppliedCodexActivationChange | undefined {
  const evidence = recovery.candidateActivation;
  if (evidence === undefined) {
    return undefined;
  }
  return {
    kind: "codex-cli-plugin",
    executablePath: old.executablePath,
    pluginId: evidence.pluginId,
    pluginName: "huaweicloud-mate",
    marketplaceName: old.marketplaceName,
    version: evidence.version,
    installedEntryHash: evidence.installedEntryHash,
    changed: true,
    installed: true,
    enabled: true,
  };
}

async function removeCandidateActivationIfPresent(
  bound: BoundCodexInstallation,
  recovery: CodexUpgradeRecovery,
  runner: HostCommandRunner,
): Promise<boolean> {
  try {
    const oldStatus = await inspectCodexPluginActivationRollback(
      bound.activationChange,
      runner,
    );
    return oldStatus === "removed";
  } catch {
    const candidate = candidateActivation(recovery, bound.activationChange);
    if (candidate === undefined) {
      return conflict(
        "Codex activation is neither the previous entry nor a recorded candidate entry",
      );
    }
    try {
      const candidateStatus = await inspectCodexPluginActivationRollback(
        candidate,
        runner,
      );
      if (candidateStatus !== "installed") {
        return conflict("Recorded Codex candidate activation is not installed");
      }
      await rollbackCodexPluginActivation(candidate, runner);
      return true;
    } catch (error) {
      if (
        error instanceof InstallerError &&
        error.code === "UPGRADE_RECOVERY_CONFLICT"
      ) {
        throw error;
      }
      return conflict("Recorded Codex candidate activation could not be removed");
    }
  }
}

async function restoreOldPointer(
  runtimeRoot: string,
  bound: BoundCodexInstallation,
  recovery: CodexUpgradeRecovery,
): Promise<void> {
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (active === undefined) {
    return conflict("Active runtime pointer is missing during recovery");
  }
  if (
    active.pluginVersion === recovery.oldPluginVersion &&
    active.installManifestSha256 === recovery.oldInstallManifestSha256
  ) {
    if (active.sha256 !== recovery.oldActiveRuntimeSha256) {
      return conflict("Previous active runtime pointer bytes changed during recovery");
    }
    return;
  }
  if (
    active.pluginVersion !== recovery.candidatePluginVersion ||
    active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
    (recovery.candidateActiveRuntimeSha256 !== undefined &&
      active.sha256 !== recovery.candidateActiveRuntimeSha256)
  ) {
    return conflict("Active runtime pointer is neither the previous nor candidate runtime");
  }
  const restored = await activateMaterializedRuntime(bound.runtime, active.sha256);
  if (!restored.changed || restored.installedSha256 !== recovery.oldActiveRuntimeSha256) {
    return conflict("Previous active runtime pointer could not be restored exactly");
  }
}

async function restoreOldAsset(
  bound: BoundCodexInstallation,
  candidate: MaterializedRuntime,
  recovery: CodexUpgradeRecovery,
  homeDirectory: string,
): Promise<void> {
  let oldRemoved = false;
  try {
    oldRemoved = (await inspectHostAssetRollback(bound.assetChange)) === "removed";
  } catch {
    const plan = await candidatePlan(candidate, homeDirectory);
    if (
      plan.pluginSourcePath === undefined ||
      plan.pluginTargetPath === undefined ||
      !samePath(plan.pluginTargetPath, bound.assetChange.targetPath) ||
      !samePath(plan.configPath, bound.plan.configPath)
    ) {
      return conflict("Recovery candidate changes the fixed Codex asset path");
    }
    const expectedTreeHash = await expectedHostAssetTreeHash(plan, candidate);
    if (expectedTreeHash !== recovery.candidateAssetTreeHash) {
      return conflict("Recovery candidate asset evidence does not match its runtime");
    }
    const candidateChange: AppliedHostAssetChange = {
      hostId: "codex",
      kind: "plugin",
      sourcePath: plan.pluginSourcePath,
      targetPath: plan.pluginTargetPath,
      changed: true,
      installedTreeHash: recovery.candidateAssetTreeHash,
      createdPaths: [plan.pluginTargetPath],
    };
    try {
      if ((await inspectHostAssetRollback(candidateChange)) !== "installed") {
        return conflict("Recorded Codex candidate asset is not installed");
      }
      await rollbackHostAssetChange(candidateChange);
      oldRemoved = true;
    } catch (error) {
      if (
        error instanceof InstallerError &&
        error.code === "UPGRADE_RECOVERY_CONFLICT"
      ) {
        throw error;
      }
      return conflict("Recorded Codex candidate asset could not be removed");
    }
  }
  if (!oldRemoved) {
    return;
  }
  const restored = await materializeHostAssets(bound.plan, bound.runtime);
  if (restored.installedTreeHash !== bound.assetChange.installedTreeHash) {
    return conflict("Previous Codex asset could not be restored exactly");
  }
}

async function verifyCommittedCandidate(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
  recovery: CodexUpgradeRecovery,
): Promise<void> {
  const snapshot = await readInstallState(runtimeRoot);
  if (
    snapshot === undefined ||
    snapshot.state.pluginVersion !== recovery.candidatePluginVersion ||
    snapshot.state.installManifestSha256 !==
      recovery.candidateInstallManifestSha256
  ) {
    return conflict("Install state is neither the previous nor candidate version");
  }
  const bound = await bindCodexInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  const activation = recovery.candidateActivation;
  if (
    activation === undefined ||
    !bound.assetChange.changed ||
    bound.assetChange.installedTreeHash !== recovery.candidateAssetTreeHash ||
    !bound.activationChange.changed ||
    bound.activationChange.pluginId !== activation.pluginId ||
    bound.activationChange.version !== activation.version ||
    bound.activationChange.installedEntryHash !== activation.installedEntryHash
  ) {
    return conflict("Committed candidate state does not match recovery evidence");
  }
  await inspectBoundCodexInstallation(bound, runner);
  await verifyBoundCodexInstallation(bound, runner);
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    active === undefined ||
    active.pluginVersion !== recovery.candidatePluginVersion ||
    active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
    recovery.candidateActiveRuntimeSha256 === undefined ||
    active.sha256 !== recovery.candidateActiveRuntimeSha256
  ) {
    return conflict("Committed candidate active runtime evidence is incomplete");
  }
}

export async function recoverInterruptedCodexUpgrade(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
): Promise<CodexUpgradeRecoveryResult> {
  const marker = await readCodexUpgradeRecovery(runtimeRoot);
  if (marker === undefined) {
    return "absent";
  }
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    return conflict("Codex upgrade recovery requires an install state");
  }
  if (snapshot.sha256 !== marker.recovery.oldStateSha256) {
    await verifyCommittedCandidate(
      runtimeRoot,
      homeDirectory,
      runner,
      marker.recovery,
    );
    await removeCodexUpgradeRecovery(runtimeRoot, marker.sha256);
    return "completed";
  }
  if (
    snapshot.state.pluginVersion !== marker.recovery.oldPluginVersion ||
    snapshot.state.installManifestSha256 !==
      marker.recovery.oldInstallManifestSha256
  ) {
    return conflict("Previous install state does not match the recovery marker");
  }

  const bound = await bindCodexInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  if (!bound.assetChange.changed || !bound.activationChange.changed) {
    return conflict("Recovery cannot take ownership of a pre-existing Codex resource");
  }
  await verifyCodexMarketplaceChange(bound.registrationChange);
  const candidate = await candidateRuntime(
    runtimeRoot,
    marker.recovery,
    bound.runtime.stableLauncherPath,
  );
  const plan = await candidatePlan(candidate, homeDirectory);
  if (
    plan.pluginTargetPath === undefined ||
    plan.pluginSourcePath === undefined ||
    !samePath(plan.pluginTargetPath, bound.assetChange.targetPath) ||
    !samePath(plan.configPath, bound.plan.configPath) ||
    (await expectedHostAssetTreeHash(plan, candidate)) !==
      marker.recovery.candidateAssetTreeHash
  ) {
    return conflict("Recovery candidate does not match the fixed Codex plan");
  }

  const oldActivationRemoved = await removeCandidateActivationIfPresent(
    bound,
    marker.recovery,
    runner,
  );
  await restoreOldPointer(runtimeRoot, bound, marker.recovery);
  await restoreOldAsset(bound, candidate, marker.recovery, homeDirectory);
  if (oldActivationRemoved) {
    await verifyCodexMarketplaceChange(bound.registrationChange);
    await applyCodexPluginActivation(
      bound.registrationChange.marketplaceName,
      runner,
    );
  }
  await verifyCodexPluginActivation(bound.activationChange, runner);
  await verifyBoundCodexInstallation(bound, runner);
  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  const stateAfter = await readInstallState(runtimeRoot);
  if (
    active?.sha256 !== marker.recovery.oldActiveRuntimeSha256 ||
    stateAfter?.sha256 !== marker.recovery.oldStateSha256
  ) {
    return conflict("Previous Codex installation changed during recovery");
  }
  await removeCodexUpgradeRecovery(runtimeRoot, marker.sha256);
  return "rolled-back";
}
