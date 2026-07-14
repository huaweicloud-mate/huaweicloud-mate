import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { InstallerError } from "./errors.js";

const pluginName = "huaweicloud-mate";
const marketplaceNamePattern = /^[A-Za-z0-9._-]{1,64}$/u;
const boundedTextPattern = /^.{1,256}$/u;

export interface AppliedCodexActivationChange {
  readonly kind: "codex-cli-plugin";
  readonly executablePath: string;
  readonly pluginId: string;
  readonly pluginName: "huaweicloud-mate";
  readonly marketplaceName: string;
  readonly version: string;
  readonly installedEntryHash: string;
  readonly changed: boolean;
  readonly installed: true;
  readonly enabled: true;
}

interface InstalledPlugin {
  readonly pluginId: string;
  readonly pluginName: "huaweicloud-mate";
  readonly marketplaceName: string;
  readonly version: string;
  readonly installedEntryHash: string;
  readonly installed: true;
  readonly enabled: true;
}

function invalid(message: string): never {
  throw new InstallerError("CODEX_ACTIVATION_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("CODEX_ACTIVATION_CONFLICT", message);
}

function failed(message: string): never {
  throw new InstallerError("CODEX_ACTIVATION_FAILED", message);
}

function outcomeUnknown(message: string): never {
  throw new InstallerError("CODEX_ACTIVATION_OUTCOME_UNKNOWN", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("CODEX_ACTIVATION_ROLLBACK_CONFLICT", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        return invalid("Codex plugin output contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Codex plugin output contains a cycle");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) =>
            `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`,
          )
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return invalid("Codex plugin output contains a non-JSON value");
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(value), "utf8")
    .digest("hex")}`;
}

function validateMarketplaceName(marketplaceName: string): void {
  if (!marketplaceNamePattern.test(marketplaceName)) {
    return invalid("Codex marketplace name is invalid");
  }
}

function commandSucceeded(result: HostCommandResult): boolean {
  return result.code === 0 && result.signal === null;
}

function parseListOutput(
  stdout: string,
  marketplaceName: string,
): InstalledPlugin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return invalid("Codex plugin list did not return valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.installed)) {
    return invalid("Codex plugin list JSON has an invalid shape");
  }

  const matches: Record<string, unknown>[] = [];
  for (const candidate of value.installed) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      typeof candidate.marketplaceName !== "string"
    ) {
      return invalid("Codex plugin list contains an invalid installed entry");
    }
    if (
      candidate.name === pluginName &&
      candidate.marketplaceName === marketplaceName
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    return conflict("Codex lists duplicate installed plugin identities");
  }

  const match = matches[0]!;
  if (
    typeof match.pluginId !== "string" ||
    !boundedTextPattern.test(match.pluginId) ||
    typeof match.version !== "string" ||
    !boundedTextPattern.test(match.version) ||
    match.installed !== true ||
    typeof match.enabled !== "boolean" ||
    match.source === undefined
  ) {
    return invalid("Codex installed plugin evidence is incomplete");
  }
  if (!match.enabled) {
    return conflict("Codex plugin is installed but disabled; refusing to change user state");
  }
  return {
    pluginId: match.pluginId,
    pluginName,
    marketplaceName,
    version: match.version,
    installedEntryHash: digest(match),
    installed: true,
    enabled: true,
  };
}

async function queryInstalledPlugin(
  executablePath: string,
  marketplaceName: string,
  runner: HostCommandRunner,
): Promise<InstalledPlugin | undefined> {
  const result = await runner.run(executablePath, [
    "plugin",
    "list",
    "--marketplace",
    marketplaceName,
    "--json",
  ]);
  if (!commandSucceeded(result)) {
    return failed("Codex plugin discovery failed");
  }
  return parseListOutput(result.stdout, marketplaceName);
}

function sameInstalledPlugin(
  current: InstalledPlugin,
  expected: AppliedCodexActivationChange,
): boolean {
  return current.pluginId === expected.pluginId &&
    current.pluginName === expected.pluginName &&
    current.marketplaceName === expected.marketplaceName &&
    current.version === expected.version &&
    current.installedEntryHash === expected.installedEntryHash;
}

function validateChange(change: AppliedCodexActivationChange): void {
  validateMarketplaceName(change.marketplaceName);
  if (
    change.kind !== "codex-cli-plugin" ||
    !isAbsolute(change.executablePath) ||
    change.pluginName !== pluginName ||
    !boundedTextPattern.test(change.pluginId) ||
    !boundedTextPattern.test(change.version) ||
    !/^sha256:[a-f0-9]{64}$/u.test(change.installedEntryHash) ||
    change.installed !== true ||
    change.enabled !== true
  ) {
    return invalid("Codex activation evidence is invalid");
  }
}

export async function applyCodexPluginActivation(
  marketplaceName: string,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<AppliedCodexActivationChange> {
  validateMarketplaceName(marketplaceName);
  let executablePath: string | undefined;
  try {
    executablePath = await runner.resolveCommand("codex");
  } catch {
    return failed("Codex command discovery failed");
  }
  if (executablePath === undefined) {
    return failed("Codex command was not found");
  }
  if (!isAbsolute(executablePath)) {
    return invalid("Codex command path is not absolute");
  }

  let before: InstalledPlugin | undefined;
  try {
    before = await queryInstalledPlugin(executablePath, marketplaceName, runner);
  } catch (error) {
    if (
      error instanceof InstallerError &&
      (error.code === "CODEX_ACTIVATION_INVALID" ||
        error.code === "CODEX_ACTIVATION_CONFLICT")
    ) {
      throw error;
    }
    return failed("Codex installed plugin state could not be inspected");
  }
  if (before !== undefined) {
    return {
      kind: "codex-cli-plugin",
      executablePath,
      ...before,
      changed: false,
    };
  }

  let addFailed = false;
  try {
    const result = await runner.run(
      executablePath,
      ["plugin", "add", `${pluginName}@${marketplaceName}`, "--json"],
      60_000,
    );
    addFailed = !commandSucceeded(result);
  } catch {
    addFailed = true;
  }

  let installed: InstalledPlugin | undefined;
  try {
    installed = await queryInstalledPlugin(executablePath, marketplaceName, runner);
  } catch {
    return outcomeUnknown(
      "Codex plugin activation was attempted but its resulting state could not be inspected",
    );
  }
  if (installed === undefined) {
    return failed(
      addFailed
        ? "Codex plugin add failed and the plugin is not installed"
        : "Codex plugin add completed without installing the plugin",
    );
  }
  return {
    kind: "codex-cli-plugin",
    executablePath,
    ...installed,
    changed: true,
  };
}

export async function verifyCodexPluginActivation(
  change: AppliedCodexActivationChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateChange(change);
  let current: InstalledPlugin | undefined;
  try {
    current = await queryInstalledPlugin(
      change.executablePath,
      change.marketplaceName,
      runner,
    );
  } catch {
    return conflict("Codex plugin activation could not be verified");
  }
  if (current === undefined || !sameInstalledPlugin(current, change)) {
    return conflict("Codex plugin activation changed before verification");
  }
}

export async function rollbackCodexPluginActivation(
  change: AppliedCodexActivationChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateChange(change);
  if (!change.changed) {
    return;
  }

  let current: InstalledPlugin | undefined;
  try {
    current = await queryInstalledPlugin(
      change.executablePath,
      change.marketplaceName,
      runner,
    );
  } catch {
    return rollbackConflict(
      "Codex plugin state could not be inspected before rollback",
    );
  }
  if (current === undefined) {
    return;
  }
  if (!sameInstalledPlugin(current, change)) {
    return rollbackConflict(
      "Codex plugin changed after installation; refusing to remove it",
    );
  }

  try {
    await runner.run(
      change.executablePath,
      [
        "plugin",
        "remove",
        `${pluginName}@${change.marketplaceName}`,
        "--json",
      ],
      60_000,
    );
  } catch {
    // The postcondition below is authoritative even when the command reports an error.
  }

  let after: InstalledPlugin | undefined;
  try {
    after = await queryInstalledPlugin(
      change.executablePath,
      change.marketplaceName,
      runner,
    );
  } catch {
    return rollbackConflict(
      "Codex plugin rollback outcome could not be inspected",
    );
  }
  if (after !== undefined) {
    return rollbackConflict("Codex plugin remains installed after rollback");
  }
}
