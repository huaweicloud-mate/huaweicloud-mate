import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { createHostInstallPlan, type HostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import { createInitialHostVerificationHook } from "../hosts/verification.js";
import {
  bindConfigHostInstallation,
  inspectBoundConfigHostInstallation,
  type ConfigHostId,
  verifyBoundConfigHostInstallation,
} from "./config-host-installation.js";
import { recoverInterruptedConfigHostUpgrade } from "./config-host-upgrade-recovery.js";
import {
  removeConfigHostUpgradeRecovery,
  replaceConfigHostUpgradeRecovery,
  type ConfigHostUpgradeRecoverySnapshot,
} from "./config-host-upgrade-recovery-state.js";
import { applyHostConfigChange } from "./config-transaction.js";
import { InstallerError } from "./errors.js";
import {
  expectedHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
  type AppliedHostAssetChange,
} from "./host-assets.js";
import {
  createInstallState,
  readInstallState,
  replaceInstallState,
  type CompletedHostInstallation,
} from "./install-state.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
} from "./runtime.js";

export interface ConfigHostUpgradeOptions {
  readonly host: ConfigHostId;
  readonly runtimeRoot: string;
  readonly sourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe: () => Promise<void>;
}

export interface ConfigHostUpgradeResult {
  readonly host: ConfigHostId;
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
  host: ConfigHostId,
  runtime: Awaited<ReturnType<typeof materializeRuntimeCandidate>>,
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

async function assertConfigUnchanged(
  runtimeRoot: string,
  plan: HostInstallPlan,
  expectedValueHash: string,
): Promise<void> {
  const inspected = await applyHostConfigChange(
    plan,
    resolve(runtimeRoot, "backups", plan.id),
  );
  if (inspected.changed || inspected.installedValueHash !== expectedValueHash) {
    return conflict("Config-host candidate changes the managed config entry");
  }
}

export async function upgradeConfigHost(
  options: ConfigHostUpgradeOptions,
): Promise<ConfigHostUpgradeResult> {
  if (!isAbsolute(options.runtimeRoot)) {
    return invalid("Managed config-host upgrade runtime root must be absolute");
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  const runner = options.runner ?? new NodeHostCommandRunner();
  await recoverInterruptedConfigHostUpgrade(runtimeRoot, homeDirectory);
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    return invalid("Managed config-host upgrade requires an install state");
  }
  const bound = await bindConfigHostInstallation({
    host: options.host,
    runtimeRoot,
    snapshot,
    homeDirectory,
  });
  await inspectBoundConfigHostInstallation(bound);
  await verifyBoundConfigHostInstallation(bound);
  const activeBefore = await readActiveRuntimeSnapshot(runtimeRoot);
  if (
    activeBefore === undefined ||
    activeBefore.pluginVersion !== snapshot.state.pluginVersion ||
    activeBefore.installManifestSha256 !== snapshot.state.installManifestSha256
  ) {
    return conflict("Active runtime does not match the managed config-host state");
  }

  const candidate = await materializeRuntimeCandidate({
    ...(options.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: options.sourceDirectory }),
    runtimeRoot,
  });
  const plan = await candidatePlan(options.host, candidate, homeDirectory);
  assertFixedPlan(bound.plan, plan);
  await assertConfigUnchanged(
    runtimeRoot,
    plan,
    bound.configChange.installedValueHash,
  );

  const currentCompleted: CompletedHostInstallation = {
    plan: bound.plan,
    configChange: bound.configChange,
    assetChange: bound.assetChange,
  };
  if (
    candidate.pluginVersion === snapshot.state.pluginVersion &&
    candidate.installManifestSha256 === snapshot.state.installManifestSha256
  ) {
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: bound.runtime, completedHosts: [currentCompleted] });
    return {
      host: options.host,
      status: "unchanged",
      changed: false,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: snapshot.state.pluginVersion,
      runtimePath: snapshot.state.runtimePath,
    };
  }

  const candidateAssetTreeHash = await expectedHostAssetTreeHash(plan, candidate);
  if (
    candidateAssetTreeHash !== bound.assetChange.installedTreeHash &&
    !bound.assetChange.changed
  ) {
    return conflict("Managed upgrade cannot replace an unowned config-host asset");
  }
  let marker: ConfigHostUpgradeRecoverySnapshot =
    await replaceConfigHostUpgradeRecovery(
      runtimeRoot,
      {
        schemaVersion: 1,
        host: options.host,
        oldStateSha256: snapshot.sha256,
        oldPluginVersion: snapshot.state.pluginVersion,
        oldInstallManifestSha256: snapshot.state.installManifestSha256,
        oldActiveRuntimeSha256: activeBefore.sha256,
        candidatePluginVersion: candidate.pluginVersion,
        candidateInstallManifestSha256: candidate.installManifestSha256,
        candidateAssetTreeHash,
      },
      null,
    );

  try {
    let candidateAsset: AppliedHostAssetChange;
    if (candidateAssetTreeHash === bound.assetChange.installedTreeHash) {
      candidateAsset = {
        ...bound.assetChange,
        sourcePath: plan.skillSourcePath,
      };
    } else {
      await rollbackHostAssetChange(bound.assetChange);
      candidateAsset = await materializeHostAssets(plan, candidate);
      if (
        !candidateAsset.changed ||
        candidateAsset.installedTreeHash !== candidateAssetTreeHash
      ) {
        return conflict("Candidate config-host asset was not installed by upgrade");
      }
    }

    const activeChange = await activateMaterializedRuntime(
      candidate,
      activeBefore.sha256,
    );
    if (!activeChange.changed) {
      return conflict("Candidate active runtime did not change during upgrade");
    }
    marker = await replaceConfigHostUpgradeRecovery(
      runtimeRoot,
      {
        ...marker.recovery,
        candidateActiveRuntimeSha256: activeChange.installedSha256,
      },
      marker.sha256,
    );
    const completed: CompletedHostInstallation = {
      plan,
      configChange: bound.configChange,
      assetChange: candidateAsset,
    };
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: candidate, completedHosts: [completed] });
    const state = createInstallState(candidate, [completed]);
    await replaceInstallState(runtimeRoot, state, snapshot.sha256);
    try {
      await removeConfigHostUpgradeRecovery(runtimeRoot, marker.sha256);
    } catch {
      // install-state is the final commit; a verified stale marker is removed on retry.
    }
    return {
      host: options.host,
      status: "upgraded",
      changed: true,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: candidate.pluginVersion,
      runtimePath: candidate.versionDirectory,
    };
  } catch (error) {
    try {
      await recoverInterruptedConfigHostUpgrade(runtimeRoot, homeDirectory);
    } catch {
      throw new InstallerError(
        "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
        "Config-host upgrade failed and the previous installation could not be restored",
      );
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "UPGRADE_TRANSACTION_FAILED",
      "Config-host managed upgrade failed",
    );
  }
}
