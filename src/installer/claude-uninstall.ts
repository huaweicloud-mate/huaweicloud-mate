import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { rollbackClaudePluginActivation } from "./claude-activation.js";
import {
  bindClaudeInstallation,
  inspectBoundClaudeInstallation,
} from "./claude-installation.js";
import {
  rollbackClaudeMarketplaceCatalog,
  rollbackClaudeMarketplaceRegistration,
} from "./claude-marketplace.js";
import { InstallerError } from "./errors.js";
import { rollbackHostAssetChange } from "./host-assets.js";
import {
  installStatePath,
  readInstallState,
  rollbackInstallStateChange,
} from "./install-state.js";

export interface ClaudeUninstallOptions {
  readonly runtimeRoot: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
}

export interface ClaudeUninstallResult {
  readonly host: "claude";
  readonly status: "uninstalled" | "not-installed";
  readonly changed: boolean;
  readonly removed: {
    readonly activation: boolean;
    readonly marketplaceRegistration: boolean;
    readonly catalog: boolean;
    readonly asset: boolean;
    readonly state: boolean;
  };
  readonly retainedRuntimePath?: string;
}

function invalid(message: string): never {
  throw new InstallerError("UNINSTALL_TRANSACTION_INVALID", message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function runtimeExists(runtimeRoot: string): Promise<boolean> {
  try {
    const entry = await lstat(runtimeRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return invalid("Uninstall runtime root is not a regular directory");
    }
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function notInstalled(): ClaudeUninstallResult {
  return {
    host: "claude",
    status: "not-installed",
    changed: false,
    removed: {
      activation: false,
      marketplaceRegistration: false,
      catalog: false,
      asset: false,
      state: false,
    },
  };
}

export async function uninstallClaude(
  options: ClaudeUninstallOptions,
): Promise<ClaudeUninstallResult> {
  try {
    if (!isAbsolute(options.runtimeRoot)) {
      return invalid("Uninstall runtime root must be absolute");
    }
    const runtimeRoot = resolve(options.runtimeRoot);
    if (!(await runtimeExists(runtimeRoot))) {
      return notInstalled();
    }
    const snapshot = await readInstallState(runtimeRoot);
    if (snapshot === undefined) {
      return notInstalled();
    }
    const runner = options.runner ?? new NodeHostCommandRunner();
    const bound = await bindClaudeInstallation({
      runtimeRoot,
      snapshot,
      runner,
      ...(options.homeDirectory === undefined
        ? {}
        : { homeDirectory: options.homeDirectory }),
    });

    await inspectBoundClaudeInstallation(bound, runner);

    const removeActivation = bound.activationChange.changed;
    const removeRegistration =
      removeActivation && bound.registrationChange.changed;
    const removeCatalog = removeRegistration && bound.catalogChange.changed;
    const removeAsset = removeCatalog && bound.assetChange.changed;
    if (removeActivation) {
      await rollbackClaudePluginActivation(bound.activationChange, runner);
    }
    if (removeRegistration) {
      await rollbackClaudeMarketplaceRegistration(
        bound.registrationChange,
        runner,
      );
    }
    if (removeCatalog) {
      await rollbackClaudeMarketplaceCatalog(bound.catalogChange);
    }
    if (removeAsset) {
      await rollbackHostAssetChange(bound.assetChange);
    }
    await rollbackInstallStateChange({
      statePath: installStatePath(runtimeRoot),
      changed: true,
      createdFile: true,
      installedSha256: snapshot.sha256,
    });

    return {
      host: "claude",
      status: "uninstalled",
      changed: true,
      removed: {
        activation: removeActivation,
        marketplaceRegistration: removeRegistration,
        catalog: removeCatalog,
        asset: removeAsset,
        state: true,
      },
      retainedRuntimePath: snapshot.state.runtimePath,
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UNINSTALL_TRANSACTION_FAILED",
      "Claude uninstall transaction failed",
    );
  }
}
