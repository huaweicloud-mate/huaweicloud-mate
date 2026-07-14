import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { InitialInstallVerificationContext } from "../installer/initial-install.js";
import { InstallerError } from "../installer/errors.js";
import { verifyHostAssetChange } from "../installer/host-assets.js";
import { verifyHostConfigChange } from "../installer/config-transaction.js";
import type { HostId } from "./types.js";
import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "./command-runner.js";

const pluginName = "huaweicloud-mate";
const mcpEntryKey = "huaweicloud-agent";

export interface HostVerificationEvidence {
  readonly id: HostId;
  readonly executablePath?: string;
  readonly detectedPaths: readonly string[];
  readonly checks: readonly (
    | "config"
    | "config-registration"
    | "plugin-registration"
    | "mcp-registration"
    | "router"
    | "skill"
  )[];
}

export interface InitialHostVerificationReport {
  readonly hosts: readonly HostVerificationEvidence[];
  readonly approvalProbe: "passed";
}

export interface InitialHostVerificationOptions {
  readonly runner?: HostCommandRunner;
  readonly approvalProbe: () => Promise<void>;
}

function invalid(message: string): never {
  throw new InstallerError("HOST_VERIFICATION_INVALID", message);
}

function discoveryFailed(message: string): never {
  throw new InstallerError("HOST_DISCOVERY_FAILED", message);
}

function registrationMissing(message: string): never {
  throw new InstallerError("HOST_REGISTRATION_MISSING", message);
}

function verificationFailed(message: string): never {
  throw new InstallerError("HOST_VERIFICATION_FAILED", message);
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    try {
      await lstat(path);
      found.push(resolve(path));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      return verificationFailed("Host detection path could not be inspected");
    }
  }
  return found;
}

async function resolveHostCommand(
  commands: readonly string[],
  runner: HostCommandRunner,
): Promise<string | undefined> {
  for (const command of commands) {
    const executable = await runner.resolveCommand(command);
    if (executable !== undefined) {
      return executable;
    }
  }
  return undefined;
}

function commandSucceeded(result: HostCommandResult, description: string): string {
  if (result.code !== 0 || result.signal !== null) {
    return verificationFailed(`${description} failed`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function containsText(output: string, token: string): boolean {
  return output.toLowerCase().includes(token.toLowerCase());
}

function containsPluginToken(output: string): boolean {
  return output
    .split(/\r?\n/gu)
    .flatMap((line) => line.split(/\s+/gu))
    .some((token) => {
      const normalized = token
        .toLowerCase()
        .replace(/^[^a-z0-9_-]+|[^a-z0-9_@.-]+$/gu, "");
      return isPluginIdentity(normalized);
    });
}

function isPluginIdentity(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === pluginName ||
    new RegExp(`^${pluginName}@[a-z0-9._-]+$`, "u").test(normalized);
}

function jsonContainsPlugin(value: unknown): boolean {
  if (typeof value === "string") {
    return isPluginIdentity(value);
  }
  if (Array.isArray(value)) {
    return value.some(jsonContainsPlugin);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some(jsonContainsPlugin);
  }
  return false;
}

async function verifyPluginRegistration(
  id: "codex" | "claude",
  executablePath: string,
  runner: HostCommandRunner,
): Promise<void> {
  const args = id === "codex"
    ? ["plugin", "list"]
    : ["plugin", "list", "--json"];
  const result = await runner.run(executablePath, args);
  const output = commandSucceeded(result, `${id} plugin discovery`);
  if (id === "codex") {
    if (!containsPluginToken(output)) {
      return registrationMissing("Codex does not list the installed plugin");
    }
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return verificationFailed("Claude plugin list did not return valid JSON");
  }
  if (!jsonContainsPlugin(parsed)) {
    return registrationMissing("Claude Code does not list the installed plugin");
  }
}

async function verifyOpenCodeRegistration(
  executablePath: string,
  runner: HostCommandRunner,
): Promise<void> {
  const mcpOutput = commandSucceeded(
    await runner.run(executablePath, ["mcp", "list"]),
    "OpenCode MCP discovery",
  );
  if (!containsText(mcpOutput, mcpEntryKey)) {
    return registrationMissing("OpenCode does not list the managed MCP entry");
  }
  const skillOutput = commandSucceeded(
    await runner.run(executablePath, ["debug", "skill"]),
    "OpenCode Skill discovery",
  );
  if (!containsText(skillOutput, "huaweicloud")) {
    return registrationMissing("OpenCode does not list the canonical Skill");
  }
}

async function verifyRouter(
  context: InitialInstallVerificationContext,
  runner: HostCommandRunner,
): Promise<void> {
  const output = commandSucceeded(
    await runner.run(
      context.runtime.nodePath,
      [context.runtime.stableLauncherPath, "version"],
    ),
    "Stable Router launcher smoke test",
  );
  if (output.trim() !== context.runtime.pluginVersion) {
    return verificationFailed("Stable Router launcher reported an unexpected version");
  }
}

export async function verifyInitialInstallHosts(
  context: InitialInstallVerificationContext,
  options: InitialHostVerificationOptions,
): Promise<InitialHostVerificationReport> {
  if (
    context.completedHosts.length === 0 ||
    context.completedHosts.length > 4 ||
    new Set(context.completedHosts.map((host) => host.plan.id)).size !==
      context.completedHosts.length
  ) {
    return invalid("Initial host verification context is invalid");
  }
  const runner = options.runner ?? new NodeHostCommandRunner();
  await verifyRouter(context, runner);
  const hosts: HostVerificationEvidence[] = [];
  for (const completed of context.completedHosts) {
    await verifyHostAssetChange(completed.assetChange);
    if (completed.configChange !== undefined) {
      await verifyHostConfigChange(completed.configChange);
    }
    const detectedPaths = await existingPaths(completed.plan.detectPaths);
    const executablePath = await resolveHostCommand(
      completed.plan.detectCommands,
      runner,
    );
    if (
      executablePath === undefined &&
      (completed.plan.id !== "codearts" || detectedPaths.length === 0)
    ) {
      return discoveryFailed(`${completed.plan.displayName} was not detected`);
    }

    const checks: HostVerificationEvidence["checks"][number][] = [
      "config",
      "router",
      "skill",
    ];
    switch (completed.plan.id) {
      case "codex":
      case "claude":
        if (executablePath === undefined) {
          return discoveryFailed(`${completed.plan.displayName} command was not detected`);
        }
        await verifyPluginRegistration(completed.plan.id, executablePath, runner);
        checks.push("plugin-registration");
        break;
      case "opencode":
        if (executablePath === undefined) {
          return discoveryFailed("OpenCode command was not detected");
        }
        await verifyOpenCodeRegistration(executablePath, runner);
        checks.push("mcp-registration");
        break;
      case "codearts":
        checks.push("config-registration");
        break;
    }
    hosts.push({
      id: completed.plan.id,
      ...(executablePath === undefined ? {} : { executablePath }),
      detectedPaths,
      checks,
    });
  }
  try {
    await options.approvalProbe();
  } catch {
    return verificationFailed("Trusted approval probe failed");
  }
  return {
    hosts,
    approvalProbe: "passed",
  };
}

export function createInitialHostVerificationHook(
  options: InitialHostVerificationOptions,
): (context: InitialInstallVerificationContext) => Promise<void> {
  return async (context) => {
    await verifyInitialInstallHosts(context, options);
  };
}
