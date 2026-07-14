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
  applyCodexPluginActivation,
  rollbackCodexPluginActivation,
  verifyCodexPluginActivation,
  type AppliedCodexActivationChange,
} from "./codex-activation.js";
import {
  bindCodexInstallation,
  inspectBoundCodexInstallation,
  verifyBoundCodexInstallation,
} from "./codex-installation.js";
import { verifyCodexMarketplaceChange } from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import {
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
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
  rollbackActiveRuntimeChange,
  type AppliedActiveRuntimeChange,
} from "./runtime.js";

export interface CodexUpgradeOptions {
  readonly runtimeRoot: string;
  readonly sourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly approvalProbe: () => Promise<void>;
}

export interface CodexUpgradeResult {
  readonly host: "codex";
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
    registry.get("codex"),
    runtime,
    process.platform as "win32" | "darwin" | "linux",
    homeDirectory,
  );
}

export async function upgradeCodex(
  options: CodexUpgradeOptions,
): Promise<CodexUpgradeResult> {
  if (!isAbsolute(options.runtimeRoot)) {
    return invalid("Managed Codex upgrade runtime root must be absolute");
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  const runner = options.runner ?? new NodeHostCommandRunner();
  const homeDirectory = options.homeDirectory ?? homedir();
  const snapshot = await readInstallState(runtimeRoot);
  if (snapshot === undefined) {
    return invalid("Managed Codex upgrade requires an existing install state");
  }
  const bound = await bindCodexInstallation({
    runtimeRoot,
    snapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  await inspectBoundCodexInstallation(bound, runner);
  await verifyBoundCodexInstallation(bound, runner);
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
    return conflict("Candidate Codex plan changes a fixed managed path");
  }

  if (
    candidate.pluginVersion === snapshot.state.pluginVersion &&
    candidate.installManifestSha256 === snapshot.state.installManifestSha256
  ) {
    const completed: CompletedHostInstallation = {
      plan: bound.plan,
      assetChange: bound.assetChange,
      registrationChange: bound.registrationChange,
      activationChange: bound.activationChange,
    };
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: bound.runtime, completedHosts: [completed] });
    return {
      host: "codex",
      status: "unchanged",
      changed: false,
      previousVersion: snapshot.state.pluginVersion,
      pluginVersion: snapshot.state.pluginVersion,
      runtimePath: snapshot.state.runtimePath,
    };
  }
  if (!bound.assetChange.changed || !bound.activationChange.changed) {
    return conflict(
      "Managed upgrade cannot replace a Codex asset or activation that predated installation",
    );
  }

  let oldActivationRemoved = false;
  let oldAssetRemoved = false;
  let newAsset: AppliedHostAssetChange | undefined;
  let newActivation: AppliedCodexActivationChange | undefined;
  let activeChange: AppliedActiveRuntimeChange | undefined;
  try {
    await rollbackCodexPluginActivation(bound.activationChange, runner);
    oldActivationRemoved = true;
    await rollbackHostAssetChange(bound.assetChange);
    oldAssetRemoved = true;

    newAsset = await materializeHostAssets(plan, candidate);
    if (!newAsset.changed) {
      return conflict("Candidate Codex asset was not installed by the upgrade");
    }
    newActivation = await applyCodexPluginActivation(
      bound.registrationChange.marketplaceName,
      runner,
    );
    if (!newActivation.changed) {
      return conflict("Candidate Codex activation was not installed by the upgrade");
    }
    await verifyHostAssetChange(newAsset);
    await verifyCodexMarketplaceChange(bound.registrationChange);
    await verifyCodexPluginActivation(newActivation, runner);

    activeChange = await activateMaterializedRuntime(candidate, activeBefore.sha256);
    if (!activeChange.changed) {
      return conflict("Candidate active runtime did not change during upgrade");
    }
    const completed: CompletedHostInstallation = {
      plan,
      assetChange: newAsset,
      registrationChange: bound.registrationChange,
      activationChange: newActivation,
    };
    await createInitialHostVerificationHook({
      runner,
      approvalProbe: options.approvalProbe,
    })({ runtime: candidate, completedHosts: [completed] });
    const state = createInstallState(candidate, [completed]);
    await replaceInstallState(runtimeRoot, state, snapshot.sha256);
    return {
      host: "codex",
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
      error.code === "CODEX_ACTIVATION_OUTCOME_UNKNOWN"
    );
    if (!canRestoreOldDependencies) {
      rollbackFailures.push(error);
    }
    if (newActivation !== undefined) {
      try {
        await rollbackCodexPluginActivation(newActivation, runner);
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
    if (newAsset !== undefined && canRestoreOldDependencies) {
      try {
        await rollbackHostAssetChange(newAsset);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (oldAssetRemoved && canRestoreOldDependencies) {
      try {
        const restored = await materializeHostAssets(
          bound.plan,
          bound.runtime,
        );
        if (restored.installedTreeHash !== bound.assetChange.installedTreeHash) {
          throw new InstallerError(
            "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
            "Restored Codex asset does not match the previous state",
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
        canRestoreOldDependencies = false;
      }
    }
    if (oldActivationRemoved && canRestoreOldDependencies) {
      try {
        await applyCodexPluginActivation(
          bound.registrationChange.marketplaceName,
          runner,
        );
        await verifyCodexPluginActivation(bound.activationChange, runner);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new InstallerError(
        "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
        "Codex upgrade failed and the previous installation could not be fully restored",
      );
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UPGRADE_TRANSACTION_FAILED",
      "Codex managed upgrade failed",
    );
  }
}
