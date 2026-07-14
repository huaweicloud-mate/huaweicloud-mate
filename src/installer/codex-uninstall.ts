import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { rollbackCodexPluginActivation } from "./codex-activation.js";
import { rollbackCodexMarketplaceChange } from "./codex-marketplace.js";
import {
  bindCodexInstallation,
  inspectBoundCodexInstallation,
} from "./codex-installation.js";
import { InstallerError } from "./errors.js";
import { rollbackHostAssetChange } from "./host-assets.js";
import {
  installStatePath,
  readInstallState,
  rollbackInstallStateChange,
} from "./install-state.js";

export interface CodexUninstallOptions {
  readonly runtimeRoot: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
}

export interface CodexUninstallResult {
  readonly host: "codex";
  readonly status: "uninstalled" | "not-installed";
  readonly changed: boolean;
  readonly removed: {
    readonly activation: boolean;
    readonly marketplace: boolean;
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

function notInstalled(): CodexUninstallResult {
  return {
    host: "codex",
    status: "not-installed",
    changed: false,
    removed: {
      activation: false,
      marketplace: false,
      asset: false,
      state: false,
    },
  };
}

export async function uninstallCodex(
  options: CodexUninstallOptions,
): Promise<CodexUninstallResult> {
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
    const bound = await bindCodexInstallation({
      runtimeRoot,
      snapshot,
      runner,
      ...(options.homeDirectory === undefined
        ? {}
        : { homeDirectory: options.homeDirectory }),
    });

    await inspectBoundCodexInstallation(bound, runner);

    await rollbackCodexPluginActivation(bound.activationChange, runner);
    await rollbackCodexMarketplaceChange(bound.registrationChange);
    await rollbackHostAssetChange(bound.assetChange);
    await rollbackInstallStateChange({
      statePath: installStatePath(runtimeRoot),
      changed: true,
      createdFile: true,
      installedSha256: snapshot.sha256,
    });

    return {
      host: "codex",
      status: "uninstalled",
      changed: true,
      removed: {
        activation: bound.activationChange.changed,
        marketplace: bound.registrationChange.changed,
        asset: bound.assetChange.changed,
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
      "Codex uninstall transaction failed",
    );
  }
}
