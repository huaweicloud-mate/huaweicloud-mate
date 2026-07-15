import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ConfigHostId } from "./config-host-installation.js";
import {
  bindConfigHostInstallation,
  inspectBoundConfigHostInstallation,
} from "./config-host-installation.js";
import { rollbackHostConfigChange } from "./config-transaction.js";
import { InstallerError } from "./errors.js";
import { rollbackHostAssetChange } from "./host-assets.js";
import {
  installStatePath,
  readInstallState,
  rollbackInstallStateChange,
} from "./install-state.js";

export interface ConfigHostUninstallOptions {
  readonly host: ConfigHostId;
  readonly runtimeRoot: string;
  readonly homeDirectory?: string;
}

export interface ConfigHostUninstallResult {
  readonly host: ConfigHostId;
  readonly status: "uninstalled" | "not-installed";
  readonly changed: boolean;
  readonly removed: {
    readonly config: boolean;
    readonly asset: boolean;
    readonly state: boolean;
  };
  readonly retainedRuntimePath?: string;
}

function invalid(message: string): never {
  throw new InstallerError("UNINSTALL_TRANSACTION_INVALID", message);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function notInstalled(host: ConfigHostId): ConfigHostUninstallResult {
  return {
    host,
    status: "not-installed",
    changed: false,
    removed: { config: false, asset: false, state: false },
  };
}

export async function uninstallConfigHost(
  options: ConfigHostUninstallOptions,
): Promise<ConfigHostUninstallResult> {
  try {
    if (!isAbsolute(options.runtimeRoot)) {
      return invalid("Uninstall runtime root must be absolute");
    }
    const runtimeRoot = resolve(options.runtimeRoot);
    try {
      const entry = await lstat(runtimeRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return invalid("Uninstall runtime root is not a regular directory");
      }
    } catch (error) {
      if (isMissing(error)) {
        return notInstalled(options.host);
      }
      throw error;
    }
    const snapshot = await readInstallState(runtimeRoot);
    if (snapshot === undefined) {
      return notInstalled(options.host);
    }
    const bound = await bindConfigHostInstallation({
      host: options.host,
      runtimeRoot,
      snapshot,
      ...(options.homeDirectory === undefined
        ? {}
        : { homeDirectory: options.homeDirectory }),
    });
    await inspectBoundConfigHostInstallation(bound);
    await rollbackHostConfigChange(bound.configChange);
    await rollbackHostAssetChange(bound.assetChange);
    await rollbackInstallStateChange({
      statePath: installStatePath(runtimeRoot),
      changed: true,
      createdFile: true,
      installedSha256: snapshot.sha256,
    });
    return {
      host: options.host,
      status: "uninstalled",
      changed: true,
      removed: {
        config: bound.configChange.changed,
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
      `${options.host} uninstall transaction failed`,
    );
  }
}
