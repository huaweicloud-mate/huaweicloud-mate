import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { pluginVersion } from "../version.js";
import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { createHostInstallPlan } from "../hosts/plan.js";
import { HostTemplateRegistry } from "../hosts/registry.js";
import type { HostId } from "../hosts/types.js";
import { verifyInstalledHostBindings } from "../hosts/verification.js";
import {
  bindClaudeInstallation,
  verifyBoundClaudeInstallation,
} from "../installer/claude-installation.js";
import {
  bindCodexInstallation,
  verifyBoundCodexInstallation,
} from "../installer/codex-installation.js";
import {
  bindConfigHostInstallation,
  verifyBoundConfigHostInstallation,
} from "../installer/config-host-installation.js";
import {
  InstallerError,
  type InstallerErrorCode,
} from "../installer/errors.js";
import type { CompletedHostInstallation } from "../installer/install-state.js";
import {
  readInstallState,
  type InstallStateHost,
  type InstallStateSnapshot,
} from "../installer/install-state.js";
import type { MaterializedRuntime } from "../installer/runtime.js";

export type HostDoctorStatus =
  | "managed"
  | "available"
  | "not-detected"
  | "drifted"
  | "detection-failed";

export interface HostDoctorHostReport {
  readonly id: HostId;
  readonly displayName: string;
  readonly detected: boolean;
  readonly commandDetected: boolean;
  readonly detectedPathCount: number;
  readonly managed: boolean;
  readonly status: HostDoctorStatus;
  readonly checks?: readonly string[];
  readonly errorCode?: InstallerErrorCode;
}

export interface HostDoctorReport {
  readonly schemaVersion: "huaweicloud-mate-host-doctor/v1";
  readonly ok: boolean;
  readonly installState: "absent" | "healthy" | "invalid";
  readonly pluginVersion?: string;
  readonly errorCode?: InstallerErrorCode;
  readonly hosts: readonly HostDoctorHostReport[];
}

export interface HostDoctorOptions {
  readonly runtimeRoot: string;
  readonly homeDirectory?: string;
  readonly runner?: HostCommandRunner;
  readonly contractDirectory?: URL;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

async function pathCount(paths: readonly string[]): Promise<number> {
  let count = 0;
  for (const path of paths) {
    try {
      const entry = await lstat(path);
      if ((entry.isFile() || entry.isDirectory()) && !entry.isSymbolicLink()) {
        count += 1;
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw new InstallerError(
          "HOST_VERIFICATION_FAILED",
          "Host detection path could not be inspected",
        );
      }
    }
  }
  return count;
}

async function commandDetected(
  commands: readonly string[],
  runner: HostCommandRunner,
): Promise<boolean> {
  for (const command of commands) {
    if (await runner.resolveCommand(command) !== undefined) return true;
  }
  return false;
}

function isolatedSnapshot(
  snapshot: InstallStateSnapshot,
  host: InstallStateHost,
): InstallStateSnapshot {
  return {
    sha256: snapshot.sha256,
    state: { ...snapshot.state, hosts: [host] },
  };
}

async function bindCompletedHost(
  runtimeRoot: string,
  homeDirectory: string,
  runner: HostCommandRunner,
  snapshot: InstallStateSnapshot,
  host: InstallStateHost,
): Promise<{
  readonly runtime: MaterializedRuntime;
  readonly completed: CompletedHostInstallation;
}> {
  const isolated = isolatedSnapshot(snapshot, host);
  switch (host.id) {
    case "codex": {
      const bound = await bindCodexInstallation({
        runtimeRoot,
        homeDirectory,
        runner,
        snapshot: isolated,
        requireExecutable: true,
      });
      await verifyBoundCodexInstallation(bound, runner);
      return {
        runtime: bound.runtime,
        completed: {
          plan: bound.plan,
          assetChange: bound.assetChange,
          registrationChange: bound.registrationChange,
          activationChange: bound.activationChange,
        },
      };
    }
    case "claude": {
      const bound = await bindClaudeInstallation({
        runtimeRoot,
        homeDirectory,
        runner,
        snapshot: isolated,
        requireExecutable: true,
      });
      await verifyBoundClaudeInstallation(bound, runner);
      return {
        runtime: bound.runtime,
        completed: {
          plan: bound.plan,
          assetChange: bound.assetChange,
          catalogChange: bound.catalogChange,
          registrationChange: bound.registrationChange,
          activationChange: bound.activationChange,
        },
      };
    }
    case "opencode":
    case "codearts": {
      const bound = await bindConfigHostInstallation({
        host: host.id,
        runtimeRoot,
        homeDirectory,
        snapshot: isolated,
      });
      await verifyBoundConfigHostInstallation(bound);
      return {
        runtime: bound.runtime,
        completed: {
          plan: bound.plan,
          configChange: bound.configChange,
          assetChange: bound.assetChange,
        },
      };
    }
  }
}

async function runtimeExists(runtimeRoot: string): Promise<boolean> {
  try {
    const entry = await lstat(runtimeRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new InstallerError(
        "INSTALL_STATE_INVALID",
        "Runtime root is not a regular directory",
      );
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function runHostDoctor(
  options: HostDoctorOptions,
): Promise<HostDoctorReport> {
  if (!isAbsolute(options.runtimeRoot)) {
    throw new InstallerError(
      "HOST_VERIFICATION_INVALID",
      "Host doctor runtime root must be absolute",
    );
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  const runner = options.runner ?? new NodeHostCommandRunner();
  const registry = await HostTemplateRegistry.loadBuiltIn(
    options.contractDirectory,
  );
  const discoveryRuntime: MaterializedRuntime = {
    pluginVersion,
    installManifestSha256: `sha256:${"0".repeat(64)}`,
    runtimeRoot,
    versionDirectory: resolve(runtimeRoot, "versions", pluginVersion),
    stableLauncherPath: resolve(runtimeRoot, "current", "hcloud-agent.mjs"),
    activeRuntimePath: resolve(runtimeRoot, "current", "active-runtime.json"),
    nodePath: process.execPath,
    reusedVersion: true,
  };
  const plans = registry.list().map((template) =>
    createHostInstallPlan(
      template,
      discoveryRuntime,
      process.platform as "win32" | "darwin" | "linux",
      homeDirectory,
    )
  );
  const discoveries = new Map<HostId, {
    readonly command: boolean;
    readonly paths: number;
    readonly errorCode?: InstallerErrorCode;
  }>();
  for (const plan of plans) {
    try {
      discoveries.set(plan.id, {
        command: await commandDetected(plan.detectCommands, runner),
        paths: await pathCount(plan.detectPaths),
      });
    } catch (error) {
      discoveries.set(plan.id, {
        command: false,
        paths: 0,
        errorCode: error instanceof InstallerError
          ? error.code
          : "HOST_VERIFICATION_FAILED",
      });
    }
  }

  let snapshot: InstallStateSnapshot | undefined;
  let installState: HostDoctorReport["installState"] = "absent";
  let stateErrorCode: InstallerErrorCode | undefined;
  try {
    if (await runtimeExists(runtimeRoot)) {
      snapshot = await readInstallState(runtimeRoot);
      installState = snapshot === undefined ? "absent" : "healthy";
    }
  } catch (error) {
    installState = "invalid";
    stateErrorCode = error instanceof InstallerError
      ? error.code
      : "INSTALL_STATE_INVALID";
  }

  const managedHosts = new Map(
    snapshot?.state.hosts.map((host) => [host.id, host] as const) ?? [],
  );
  const hosts: HostDoctorHostReport[] = [];
  for (const plan of plans) {
    const discovery = discoveries.get(plan.id) ?? { command: false, paths: 0 };
    const detected = discovery.command || discovery.paths > 0;
    const managed = managedHosts.get(plan.id);
    if (discovery.errorCode !== undefined) {
      hosts.push({
        id: plan.id,
        displayName: plan.displayName,
        detected: false,
        commandDetected: false,
        detectedPathCount: 0,
        managed: managed !== undefined,
        status: "detection-failed",
        errorCode: discovery.errorCode,
      });
      continue;
    }
    if (snapshot === undefined || managed === undefined) {
      hosts.push({
        id: plan.id,
        displayName: plan.displayName,
        detected,
        commandDetected: discovery.command,
        detectedPathCount: discovery.paths,
        managed: false,
        status: detected ? "available" : "not-detected",
      });
      continue;
    }
    try {
      const bound = await bindCompletedHost(
        runtimeRoot,
        homeDirectory,
        runner,
        snapshot,
        managed,
      );
      const verified = await verifyInstalledHostBindings({
        runtime: bound.runtime,
        completedHosts: [bound.completed],
      }, runner);
      hosts.push({
        id: plan.id,
        displayName: plan.displayName,
        detected: true,
        commandDetected: discovery.command,
        detectedPathCount: discovery.paths,
        managed: true,
        status: "managed",
        checks: verified.hosts[0]?.checks ?? [],
      });
    } catch (error) {
      hosts.push({
        id: plan.id,
        displayName: plan.displayName,
        detected,
        commandDetected: discovery.command,
        detectedPathCount: discovery.paths,
        managed: true,
        status: "drifted",
        errorCode: error instanceof InstallerError
          ? error.code
          : "HOST_VERIFICATION_FAILED",
      });
    }
  }

  const managedCount = hosts.filter((host) => host.status === "managed").length;
  const ok = installState === "healthy" &&
    managedCount > 0 &&
    hosts.every((host) =>
      host.status === "managed" || host.status === "not-detected"
    );
  return {
    schemaVersion: "huaweicloud-mate-host-doctor/v1",
    ok,
    installState,
    ...(snapshot === undefined ? {} : { pluginVersion: snapshot.state.pluginVersion }),
    ...(stateErrorCode === undefined ? {} : { errorCode: stateErrorCode }),
    hosts,
  };
}
