import { homedir } from "node:os";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  bindConfigHostInstallation,
  type ConfigHostId,
} from "./config-host-installation.js";
import {
  readConfigHostUpgradeRecovery,
  removeConfigHostUpgradeRecovery,
} from "./config-host-upgrade-recovery-state.js";
import { applyHostConfigChange, verifyHostConfigChange } from "./config-transaction.js";
import { InstallerError } from "./errors.js";
import {
  inspectHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
  type AppliedHostAssetChange,
} from "./host-assets.js";
import { verifyInstallDirectory } from "./install-manifest.js";
import { readInstallState } from "./install-state.js";
import {
  activateMaterializedRuntime,
  readActiveRuntimeSnapshot,
  type MaterializedRuntime,
} from "./runtime.js";

function conflict(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_CONFLICT", message);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function planFor(
  host: ConfigHostId,
  runtime: MaterializedRuntime,
  homeDirectory: string,
): Promise<HostInstallPlan> {
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(`${resolve(runtime.versionDirectory, "hosts", "templates")}${sep}`),
    pathToFileURL(`${resolve(runtime.versionDirectory, "contracts", "schema")}${sep}`),
  );
  return createHostInstallPlan(
    registry.get(host),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    homeDirectory,
  );
}

function assertFixedPlan(oldPlan: HostInstallPlan, candidate: HostInstallPlan): void {
  if (
    candidate.id !== oldPlan.id ||
    candidate.mergeStrategy !== oldPlan.mergeStrategy ||
    candidate.pluginSourcePath !== undefined ||
    candidate.pluginTargetPath !== undefined ||
    !samePath(candidate.configPath, oldPlan.configPath) ||
    !samePath(candidate.skillTargetPath, oldPlan.skillTargetPath)
  ) {
    return conflict("Config-host candidate changes a fixed managed path");
  }
}

async function candidateRuntime(
  runtimeRoot: string,
  pluginVersion: string,
  installManifestSha256: string,
  stableLauncherPath: string,
): Promise<MaterializedRuntime> {
  const versionDirectory = resolve(runtimeRoot, "versions", pluginVersion);
  const verified = await verifyInstallDirectory(
    versionDirectory,
    installManifestSha256,
  );
  if (verified.manifest.pluginVersion !== pluginVersion) {
    return conflict("Config-host recovery candidate runtime binding is invalid");
  }
  return {
    pluginVersion,
    installManifestSha256,
    runtimeRoot,
    versionDirectory,
    stableLauncherPath,
    activeRuntimePath: resolve(runtimeRoot, "current", "active-runtime.json"),
    nodePath: process.execPath,
    reusedVersion: true,
  };
}

function recoveryAsset(
  plan: HostInstallPlan,
  installedTreeHash: string,
): AppliedHostAssetChange {
  return {
    hostId: plan.id,
    kind: "skill",
    sourcePath: plan.skillSourcePath,
    targetPath: plan.skillTargetPath,
    changed: true,
    installedTreeHash,
    createdPaths: [plan.skillTargetPath],
  };
}

async function reconcileAssetQuarantines(
  targetPath: string,
  oldTreeHash: string,
  candidateTreeHash: string,
): Promise<void> {
  const parent = dirname(targetPath);
  const prefix = `.${basename(targetPath)}.`;
  const suffix = ".rollback";
  let names: string[];
  try {
    names = await readdir(parent);
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
  const quarantineNames = names.filter((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
    const token = name.slice(prefix.length, -suffix.length);
    return /^[a-f0-9]{32}$/u.test(token);
  });
  if (quarantineNames.length > 16) {
    return conflict("Config-host asset has too many rollback quarantines");
  }
  for (const name of quarantineNames.sort()) {
    const path = resolve(parent, name);
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return conflict("Config-host rollback quarantine is not a regular directory");
    }
    const hash = await inspectHostAssetTreeHash(path);
    if (hash !== oldTreeHash && hash !== candidateTreeHash) {
      return conflict("Config-host rollback quarantine contains unknown content");
    }
    const current = await inspectHostAssetTreeHash(targetPath);
    if (hash === oldTreeHash && current === undefined) {
      try {
        await rename(path, targetPath);
      } catch {
        return conflict("Config-host rollback quarantine changed during recovery");
      }
      continue;
    }
    await rm(path, { recursive: true });
  }
}

async function assertCandidateConfigUnchanged(
  runtimeRoot: string,
  plan: HostInstallPlan,
  expectedValueHash: string,
): Promise<void> {
  const inspected = await applyHostConfigChange(
    plan,
    resolve(runtimeRoot, "backups", plan.id),
  );
  if (
    inspected.changed ||
    inspected.installedValueHash !== expectedValueHash
  ) {
    return conflict("Config-host candidate changes the managed config entry");
  }
}

export async function recoverInterruptedConfigHostUpgrade(
  runtimeRootInput: string,
  homeDirectory = homedir(),
): Promise<void> {
  if (!isAbsolute(runtimeRootInput)) {
    return conflict("Config-host recovery runtime root must be absolute");
  }
  const runtimeRoot = resolve(runtimeRootInput);
  const marker = await readConfigHostUpgradeRecovery(runtimeRoot);
  if (marker === undefined) return;
  const state = await readInstallState(runtimeRoot);
  if (state === undefined || state.state.hosts.length !== 1) {
    return conflict("Config-host recovery marker has no matching install state");
  }
  const recovery = marker.recovery;
  const stateHost = state.state.hosts[0];
  if (stateHost?.id !== recovery.host) {
    return conflict("Config-host recovery marker host does not match install state");
  }

  const isOldState =
    state.sha256 === recovery.oldStateSha256 &&
    state.state.pluginVersion === recovery.oldPluginVersion &&
    state.state.installManifestSha256 === recovery.oldInstallManifestSha256;
  const isCandidateState =
    state.state.pluginVersion === recovery.candidatePluginVersion &&
    state.state.installManifestSha256 === recovery.candidateInstallManifestSha256;
  if (!isOldState && !isCandidateState) {
    return conflict("Config-host recovery install state is neither old nor candidate");
  }

  if (isCandidateState) {
    const bound = await bindConfigHostInstallation({
      host: recovery.host,
      runtimeRoot,
      snapshot: state,
      homeDirectory,
    });
    await verifyHostConfigChange(bound.configChange);
    await verifyHostAssetChange(bound.assetChange);
    if (bound.assetChange.installedTreeHash !== recovery.candidateAssetTreeHash) {
      return conflict("Committed config-host asset does not match recovery evidence");
    }
    const active = await readActiveRuntimeSnapshot(runtimeRoot);
    if (
      active === undefined ||
      active.pluginVersion !== recovery.candidatePluginVersion ||
      active.installManifestSha256 !== recovery.candidateInstallManifestSha256 ||
      (recovery.candidateActiveRuntimeSha256 !== undefined &&
        active.sha256 !== recovery.candidateActiveRuntimeSha256)
    ) {
      return conflict("Committed config-host runtime does not match recovery evidence");
    }
    await removeConfigHostUpgradeRecovery(runtimeRoot, marker.sha256);
    return;
  }

  const bound = await bindConfigHostInstallation({
    host: recovery.host,
    runtimeRoot,
    snapshot: state,
    homeDirectory,
  });
  await verifyHostConfigChange(bound.configChange);
  const candidate = await candidateRuntime(
    runtimeRoot,
    recovery.candidatePluginVersion,
    recovery.candidateInstallManifestSha256,
    bound.runtime.stableLauncherPath,
  );
  const plan = await planFor(recovery.host, candidate, homeDirectory);
  assertFixedPlan(bound.plan, plan);
  await assertCandidateConfigUnchanged(
    runtimeRoot,
    plan,
    bound.configChange.installedValueHash,
  );

  await reconcileAssetQuarantines(
    plan.skillTargetPath,
    bound.assetChange.installedTreeHash,
    recovery.candidateAssetTreeHash,
  );

  const currentAssetHash = await inspectHostAssetTreeHash(plan.skillTargetPath);
  if (currentAssetHash !== bound.assetChange.installedTreeHash) {
    if (
      currentAssetHash !== undefined &&
      currentAssetHash !== recovery.candidateAssetTreeHash
    ) {
      return conflict("Config-host asset drifted during interrupted upgrade");
    }
    if (currentAssetHash === recovery.candidateAssetTreeHash) {
      await rollbackHostAssetChange(
        recoveryAsset(plan, recovery.candidateAssetTreeHash),
      );
    }
    if (!bound.assetChange.changed) {
      return conflict("Interrupted upgrade cannot restore an unowned host asset");
    }
    const restored = await materializeHostAssets(bound.plan, bound.runtime);
    if (
      !restored.changed ||
      restored.installedTreeHash !== bound.assetChange.installedTreeHash
    ) {
      return conflict("Interrupted upgrade could not restore the old host asset");
    }
  }

  const active = await readActiveRuntimeSnapshot(runtimeRoot);
  if (active === undefined) {
    return conflict("Interrupted config-host upgrade lost the active runtime pointer");
  }
  const activeIsOld =
    active.sha256 === recovery.oldActiveRuntimeSha256 &&
    active.pluginVersion === recovery.oldPluginVersion &&
    active.installManifestSha256 === recovery.oldInstallManifestSha256;
  const activeIsCandidate =
    active.pluginVersion === recovery.candidatePluginVersion &&
    active.installManifestSha256 === recovery.candidateInstallManifestSha256 &&
    (recovery.candidateActiveRuntimeSha256 === undefined ||
      active.sha256 === recovery.candidateActiveRuntimeSha256);
  if (!activeIsOld) {
    if (!activeIsCandidate) {
      return conflict("Active runtime drifted during interrupted config-host upgrade");
    }
    await activateMaterializedRuntime(bound.runtime, active.sha256);
  }
  await verifyHostConfigChange(bound.configChange);
  await verifyHostAssetChange(bound.assetChange);
  await removeConfigHostUpgradeRecovery(runtimeRoot, marker.sha256);
}
