import { isAbsolute, resolve } from "node:path";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import type { HostInstallPlan } from "../hosts/plan.js";
import {
  applyClaudePluginActivation,
  type AppliedClaudeActivationChange,
  rollbackClaudePluginActivation,
  verifyClaudePluginActivation,
} from "./claude-activation.js";
import {
  applyClaudeMarketplaceCatalog,
  applyClaudeMarketplaceRegistration,
  type AppliedClaudeMarketplaceCatalogChange,
  type AppliedClaudeMarketplaceRegistration,
  createClaudeMarketplaceCatalogPlan,
  rollbackClaudeMarketplaceCatalog,
  rollbackClaudeMarketplaceRegistration,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
} from "./claude-marketplace.js";
import {
  applyCodexPluginActivation,
  type AppliedCodexActivationChange,
  rollbackCodexPluginActivation,
  verifyCodexPluginActivation,
} from "./codex-activation.js";
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
  catalogChange?: AppliedClaudeMarketplaceCatalogChange;
  registrationChange?:
    | AppliedCodexMarketplaceChange
    | AppliedClaudeMarketplaceRegistration;
  activationChange?:
    | AppliedCodexActivationChange
    | AppliedClaudeActivationChange;
  preservePluginDependencies?: boolean;
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
  readonly codexRunner?: HostCommandRunner;
  readonly claudeRunner?: HostCommandRunner;
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
    ...(partial.catalogChange === undefined
      ? {}
      : { catalogChange: partial.catalogChange }),
    ...(partial.registrationChange === undefined
      ? {}
      : { registrationChange: partial.registrationChange }),
    ...(partial.activationChange === undefined
      ? {}
      : { activationChange: partial.activationChange }),
  };
}

async function rollbackPartialHosts(
  applied: readonly PartialHostInstallation[],
  codexRunner: HostCommandRunner,
  claudeRunner: HostCommandRunner,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const partial of [...applied].reverse()) {
    let preservePluginDependencies =
      partial.preservePluginDependencies === true;
    if (partial.activationChange !== undefined) {
      if (
        partial.activationChange.kind === "claude-cli-plugin" &&
        !partial.activationChange.changed
      ) {
        preservePluginDependencies = true;
      }
      try {
        if (partial.activationChange.kind === "codex-cli-plugin") {
          await rollbackCodexPluginActivation(
            partial.activationChange,
            codexRunner,
          );
        } else {
          await rollbackClaudePluginActivation(
            partial.activationChange,
            claudeRunner,
          );
        }
      } catch (error) {
        failures.push(error);
        preservePluginDependencies = true;
      }
    }
    if (
      partial.registrationChange !== undefined &&
      !preservePluginDependencies
    ) {
      try {
        if ("kind" in partial.registrationChange) {
          await rollbackClaudeMarketplaceRegistration(
            partial.registrationChange,
            claudeRunner,
          );
          if (!partial.registrationChange.changed) {
            preservePluginDependencies = true;
          }
        } else {
          await rollbackCodexMarketplaceChange(partial.registrationChange);
        }
      } catch (error) {
        failures.push(error);
        preservePluginDependencies = true;
      }
    }
    if (partial.catalogChange !== undefined && !preservePluginDependencies) {
      try {
        await rollbackClaudeMarketplaceCatalog(partial.catalogChange);
        if (!partial.catalogChange.changed) {
          preservePluginDependencies = true;
        }
      } catch (error) {
        failures.push(error);
        preservePluginDependencies = true;
      }
    }
    if (partial.configChange !== undefined) {
      try {
        await rollbackHostConfigChange(partial.configChange);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!preservePluginDependencies) {
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
  codexRunner: HostCommandRunner,
  claudeRunner: HostCommandRunner,
): Promise<void> {
  for (const host of completedHosts) {
    if (host.configChange !== undefined) {
      await verifyHostConfigChange(host.configChange);
    }
    await verifyHostAssetChange(host.assetChange);
    if (host.catalogChange !== undefined) {
      await verifyClaudeMarketplaceCatalog(host.catalogChange);
    }
    if (host.registrationChange !== undefined) {
      if ("kind" in host.registrationChange) {
        await verifyClaudeMarketplaceRegistration(
          host.registrationChange,
          claudeRunner,
        );
      } else {
        await verifyCodexMarketplaceChange(host.registrationChange);
      }
    }
    if (host.activationChange !== undefined) {
      if (host.activationChange.kind === "codex-cli-plugin") {
        await verifyCodexPluginActivation(host.activationChange, codexRunner);
      } else {
        await verifyClaudePluginActivation(host.activationChange, claudeRunner);
      }
    }
  }
}

export async function runInitialInstallTransaction(
  options: InitialInstallOptions,
): Promise<InitialInstallResult> {
  const plans = validatePlans(options.plans);
  const codexRunner = options.codexRunner ?? new NodeHostCommandRunner();
  const claudeRunner = options.claudeRunner ?? new NodeHostCommandRunner();
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
        try {
          partial.activationChange = await applyCodexPluginActivation(
            partial.registrationChange.marketplaceName,
            codexRunner,
          );
        } catch (error) {
          if (
            error instanceof InstallerError &&
            error.code === "CODEX_ACTIVATION_OUTCOME_UNKNOWN"
          ) {
            partial.preservePluginDependencies = true;
          }
          throw error;
        }
      }
      if (plan.id === "claude") {
        if (plan.pluginTargetPath === undefined) {
          return invalid("Claude install plan is missing its plugin target");
        }
        partial.catalogChange = await applyClaudeMarketplaceCatalog(
          createClaudeMarketplaceCatalogPlan(
            plan.pluginTargetPath,
            options.runtime.pluginVersion,
          ),
        );
        try {
          partial.registrationChange =
            await applyClaudeMarketplaceRegistration(
              partial.catalogChange,
              claudeRunner,
            );
          partial.activationChange = await applyClaudePluginActivation(
            partial.catalogChange,
            partial.registrationChange,
            claudeRunner,
          );
        } catch (error) {
          if (
            error instanceof InstallerError &&
            (error.code === "CLAUDE_MARKETPLACE_OUTCOME_UNKNOWN" ||
              error.code === "CLAUDE_ACTIVATION_OUTCOME_UNKNOWN")
          ) {
            partial.preservePluginDependencies = true;
          }
          throw error;
        }
      }
    }

    const completedHosts = applied.map(completed);
    await verifyCompletedHosts(completedHosts, codexRunner, claudeRunner);
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
    const rollbackFailures = await rollbackPartialHosts(
      applied,
      codexRunner,
      claudeRunner,
    );
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
