import { isAbsolute, resolve } from "node:path";

import type { HostInstallPlan } from "../hosts/plan.js";
import {
  applyHostConfigChange,
  type AppliedHostConfigChange,
  rollbackHostConfigChange,
  verifyHostConfigChange,
} from "./config-transaction.js";
import {
  applyCodexMarketplaceChange,
  type AppliedCodexMarketplaceChange,
  createCodexMarketplacePlan,
  rollbackCodexMarketplaceChange,
  verifyCodexMarketplaceChange,
} from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import {
  type AppliedHostAssetChange,
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
} from "./host-assets.js";
import {
  type AppliedInstallStateChange,
  type CompletedHostInstallation,
  createInstallState,
  type InstallState,
  readInstallState,
  replaceInstallState,
} from "./install-state.js";
import type { MaterializedRuntime } from "./runtime.js";

interface PartialHostInstallation {
  readonly plan: HostInstallPlan;
  readonly assetChange: AppliedHostAssetChange;
  configChange?: AppliedHostConfigChange;
  registrationChange?: AppliedCodexMarketplaceChange;
}

export interface InitialInstallVerificationContext {
  readonly runtime: MaterializedRuntime;
  readonly completedHosts: readonly CompletedHostInstallation[];
}

export interface InitialInstallOptions {
  readonly runtime: MaterializedRuntime;
  readonly plans: readonly HostInstallPlan[];
  readonly verify?: (
    context: InitialInstallVerificationContext,
  ) => Promise<void>;
}

export interface InitialInstallResult {
  readonly state: InstallState;
  readonly stateChange: AppliedInstallStateChange;
  readonly completedHosts: readonly CompletedHostInstallation[];
}

function invalid(message: string): never {
  throw new InstallerError("INSTALL_TRANSACTION_INVALID", message);
}

function transactionConflict(message: string): never {
  throw new InstallerError("INSTALL_TRANSACTION_CONFLICT", message);
}

function compareHostIds(left: HostInstallPlan, right: HostInstallPlan): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validatePlans(plans: readonly HostInstallPlan[]): HostInstallPlan[] {
  if (plans.length === 0 || plans.length > 4) {
    return invalid("Initial install requires one to four host plans");
  }
  const sorted = [...plans].sort(compareHostIds);
  const ids = new Set<string>();
  const configPaths = new Set<string>();
  const assetTargets = new Set<string>();
  for (const plan of sorted) {
    const rawAssetTarget = plan.mergeStrategy === "plugin-manifest"
      ? plan.pluginTargetPath
      : plan.skillTargetPath;
    if (
      !isAbsolute(plan.configPath) ||
      rawAssetTarget === undefined ||
      !isAbsolute(rawAssetTarget)
    ) {
      return invalid("Initial install plan paths must be absolute and complete");
    }
    const configPath = resolve(plan.configPath);
    const assetTarget = resolve(rawAssetTarget);
    const pathKey = (path: string): string =>
      process.platform === "win32" ? path.toLowerCase() : path;
    if (
      ids.has(plan.id) ||
      configPaths.has(pathKey(configPath)) ||
      assetTargets.has(pathKey(assetTarget))
    ) {
      return invalid("Initial install plans contain duplicate host targets");
    }
    ids.add(plan.id);
    configPaths.add(pathKey(configPath));
    assetTargets.add(pathKey(assetTarget));
  }
  return sorted;
}

function completed(
  partial: PartialHostInstallation,
): CompletedHostInstallation {
  return {
    plan: partial.plan,
    assetChange: partial.assetChange,
    ...(partial.configChange === undefined
      ? {}
      : { configChange: partial.configChange }),
    ...(partial.registrationChange === undefined
      ? {}
      : { registrationChange: partial.registrationChange }),
  };
}

async function rollbackPartialHosts(
  applied: readonly PartialHostInstallation[],
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const partial of [...applied].reverse()) {
    let preserveAsset = false;
    if (partial.registrationChange !== undefined) {
      try {
        await rollbackCodexMarketplaceChange(partial.registrationChange);
      } catch (error) {
        failures.push(error);
        preserveAsset = true;
      }
    }
    if (partial.configChange !== undefined) {
      try {
        await rollbackHostConfigChange(partial.configChange);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!preserveAsset) {
      try {
        await rollbackHostAssetChange(partial.assetChange);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

async function verifyCompletedHosts(
  completedHosts: readonly CompletedHostInstallation[],
): Promise<void> {
  for (const host of completedHosts) {
    if (host.configChange !== undefined) {
      await verifyHostConfigChange(host.configChange);
    }
    await verifyHostAssetChange(host.assetChange);
    if (host.registrationChange !== undefined) {
      await verifyCodexMarketplaceChange(host.registrationChange);
    }
  }
}

export async function runInitialInstallTransaction(
  options: InitialInstallOptions,
): Promise<InitialInstallResult> {
  const plans = validatePlans(options.plans);
  const existingState = await readInstallState(options.runtime.runtimeRoot);
  if (existingState !== undefined) {
    return transactionConflict(
      "Install state already exists; managed upgrade is required",
    );
  }

  const applied: PartialHostInstallation[] = [];
  try {
    for (const plan of plans) {
      const partial: PartialHostInstallation = {
        plan,
        assetChange: await materializeHostAssets(plan, options.runtime),
      };
      applied.push(partial);
      if (plan.mergeStrategy !== "plugin-manifest") {
        partial.configChange = await applyHostConfigChange(
          plan,
          resolve(options.runtime.runtimeRoot, "backups", plan.id),
        );
      }
      if (plan.id === "codex") {
        if (plan.pluginTargetPath === undefined) {
          return invalid("Codex install plan is missing its plugin target");
        }
        partial.registrationChange = await applyCodexMarketplaceChange(
          createCodexMarketplacePlan(plan.pluginTargetPath),
          resolve(options.runtime.runtimeRoot, "backups", "codex-marketplace"),
        );
      }
    }

    const completedHosts = applied.map(completed);
    await verifyCompletedHosts(completedHosts);
    await options.verify?.({
      runtime: options.runtime,
      completedHosts,
    });
    const state = createInstallState(options.runtime, completedHosts);
    const stateChange = await replaceInstallState(
      options.runtime.runtimeRoot,
      state,
      null,
    );
    return { state, stateChange, completedHosts };
  } catch (error) {
    const rollbackFailures = await rollbackPartialHosts(applied);
    if (rollbackFailures.length > 0) {
      throw new InstallerError(
        "INSTALL_TRANSACTION_ROLLBACK_CONFLICT",
        "Initial install failed and one or more managed changes could not be rolled back",
      );
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "INSTALL_TRANSACTION_FAILED",
      "Initial install verification failed",
    );
  }
}
