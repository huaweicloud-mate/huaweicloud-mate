import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { createHostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import {
  type AppliedCodexActivationChange,
  inspectCodexPluginActivationRollback,
  rollbackCodexPluginActivation,
} from "./codex-activation.js";
import {
  type AppliedCodexMarketplaceChange,
  createCodexMarketplacePlan,
  inspectCodexMarketplaceRollback,
  rollbackCodexMarketplaceChange,
} from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import {
  type AppliedHostAssetChange,
  inspectHostAssetRollback,
  rollbackHostAssetChange,
} from "./host-assets.js";
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

function conflict(message: string): never {
  throw new InstallerError("UNINSTALL_TRANSACTION_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
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
    if (snapshot.state.hosts.length !== 1 || snapshot.state.hosts[0]?.id !== "codex") {
      return conflict(
        "Codex-only uninstall cannot modify an install state containing other hosts",
      );
    }

    const host = snapshot.state.hosts[0];
    const templateDirectory = pathToFileURL(
      `${resolve(snapshot.state.runtimePath, "hosts", "templates")}${sep}`,
    );
    const contractDirectory = pathToFileURL(
      `${resolve(snapshot.state.runtimePath, "contracts", "schema")}${sep}`,
    );
    const registry = await HostTemplateRegistry.load(
      templateDirectory,
      contractDirectory,
    );
    const plan = createHostInstallPlan(
      registry.get("codex"),
      {
        runtimeRoot,
        versionDirectory: snapshot.state.runtimePath,
        stableLauncherPath: snapshot.state.stableLauncherPath,
        nodePath: process.execPath,
      },
      process.platform as "win32" | "darwin" | "linux",
      options.homeDirectory ?? homedir(),
    );
    if (
      plan.pluginSourcePath === undefined ||
      plan.pluginTargetPath === undefined ||
      host.mergeStrategy !== plan.mergeStrategy ||
      !samePath(host.configPath, plan.configPath) ||
      !samePath(host.asset.targetPath, plan.pluginTargetPath) ||
      host.asset.kind !== "plugin"
    ) {
      return conflict("Install state does not match the fixed Codex layout");
    }
    const registration = host.registration;
    if (registration === undefined) {
      return invalid("Codex install state is missing registration evidence");
    }
    const marketplacePlan = createCodexMarketplacePlan(plan.pluginTargetPath);
    if (
      !samePath(registration.pluginPath, marketplacePlan.pluginPath) ||
      !samePath(registration.marketplacePath, marketplacePlan.marketplacePath) ||
      registration.pluginName !== marketplacePlan.pluginName ||
      registration.sourcePath !== marketplacePlan.sourcePath
    ) {
      return conflict("Install state Codex registration paths were redirected");
    }
    if (registration.backupPath !== undefined) {
      const backupDirectory = resolve(
        runtimeRoot,
        "backups",
        "codex-marketplace",
      );
      if (
        !samePath(dirname(registration.backupPath), backupDirectory) ||
        !basename(registration.backupPath).endsWith(".bak")
      ) {
        return conflict("Install state Codex backup path was redirected");
      }
    }

    const runner = options.runner ?? new NodeHostCommandRunner();
    let executablePath = resolve(runtimeRoot, "unowned-codex-command");
    if (registration.activation.changed) {
      const discovered = await runner.resolveCommand("codex");
      if (discovered === undefined || !isAbsolute(discovered)) {
        return conflict("Codex command is unavailable for managed deactivation");
      }
      executablePath = discovered;
    }
    const activationChange: AppliedCodexActivationChange = {
      ...registration.activation,
      executablePath,
    };
    const registrationChange: AppliedCodexMarketplaceChange = {
      ...marketplacePlan,
      marketplaceName: registration.marketplaceName,
      changed: registration.changed,
      createdFile: registration.createdFile,
      installedSha256: registration.installedSha256,
      installedEntryHash: registration.installedEntryHash,
      ...(registration.beforeSha256 === undefined
        ? {}
        : { beforeSha256: registration.beforeSha256 }),
      ...(registration.backupPath === undefined
        ? {}
        : { backupPath: registration.backupPath }),
      ...(registration.backupSha256 === undefined
        ? {}
        : { backupSha256: registration.backupSha256 }),
    };
    const assetChange: AppliedHostAssetChange = {
      hostId: "codex",
      kind: "plugin",
      sourcePath: plan.pluginSourcePath,
      targetPath: plan.pluginTargetPath,
      changed: host.asset.changed,
      installedTreeHash: host.asset.installedTreeHash,
      createdPaths: host.asset.changed ? [plan.pluginTargetPath] : [],
    };

    await inspectCodexPluginActivationRollback(activationChange, runner);
    await inspectCodexMarketplaceRollback(registrationChange);
    await inspectHostAssetRollback(assetChange);

    await rollbackCodexPluginActivation(activationChange, runner);
    await rollbackCodexMarketplaceChange(registrationChange);
    await rollbackHostAssetChange(assetChange);
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
        activation: registration.activation.changed,
        marketplace: registration.changed,
        asset: host.asset.changed,
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
