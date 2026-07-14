import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import {
  type AppliedClaudeMarketplaceCatalogChange,
  type AppliedClaudeMarketplaceRegistration,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
} from "./claude-marketplace.js";
import { InstallerError } from "./errors.js";

const pluginName = "huaweicloud-mate";
const marketplaceName = "huaweicloud-mate-local";
const pluginId = `${pluginName}@${marketplaceName}`;
const boundedTextPattern = /^.{1,512}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface AppliedClaudeActivationChange {
  readonly kind: "claude-cli-plugin";
  readonly executablePath: string;
  readonly pluginId: typeof pluginId;
  readonly pluginName: typeof pluginName;
  readonly marketplaceName: typeof marketplaceName;
  readonly version: string;
  readonly scope: "user";
  readonly installPath: string;
  readonly installedEntryHash: string;
  readonly changed: boolean;
  readonly installed: true;
  readonly enabled: true;
}

export type ClaudeActivationRollbackStatus =
  | "installed"
  | "removed"
  | "unowned";

interface InstalledClaudePlugin {
  readonly pluginId: typeof pluginId;
  readonly pluginName: typeof pluginName;
  readonly marketplaceName: typeof marketplaceName;
  readonly version: string;
  readonly scope: "user";
  readonly installPath: string;
  readonly installedEntryHash: string;
  readonly installed: true;
  readonly enabled: true;
}

function invalid(message: string): never {
  throw new InstallerError("CLAUDE_ACTIVATION_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("CLAUDE_ACTIVATION_CONFLICT", message);
}

function failed(message: string): never {
  throw new InstallerError("CLAUDE_ACTIVATION_FAILED", message);
}

function outcomeUnknown(message: string): never {
  throw new InstallerError("CLAUDE_ACTIVATION_OUTCOME_UNKNOWN", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("CLAUDE_ACTIVATION_ROLLBACK_CONFLICT", message);
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
        return invalid("Claude plugin output contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Claude plugin output contains a cycle");
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
      return invalid("Claude plugin output contains a non-JSON value");
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(value), "utf8")
    .digest("hex")}`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function commandSucceeded(result: HostCommandResult): boolean {
  return result.code === 0 && result.signal === null;
}

function parseListOutput(
  stdout: string,
  expectedVersion: string,
): InstalledClaudePlugin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return invalid("Claude plugin list did not return valid JSON");
  }
  if (!Array.isArray(value)) {
    return invalid("Claude plugin list JSON must be an array");
  }

  const matches: Record<string, unknown>[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !boundedTextPattern.test(candidate.id)
    ) {
      return invalid("Claude plugin list contains an invalid entry");
    }
    if (candidate.id === pluginId) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    return conflict("Claude lists duplicate managed plugin identities");
  }

  const match = matches[0]!;
  if (
    typeof match.version !== "string" ||
    !boundedTextPattern.test(match.version) ||
    match.scope !== "user" ||
    typeof match.enabled !== "boolean" ||
    typeof match.installPath !== "string" ||
    !isAbsolute(match.installPath)
  ) {
    return invalid("Claude managed plugin evidence is incomplete");
  }
  if (!match.enabled) {
    return conflict(
      "Claude plugin is installed but disabled; refusing to change user state",
    );
  }
  if (match.version !== expectedVersion) {
    return conflict("Claude plugin is installed at a different version");
  }
  const installPath = resolve(match.installPath);
  if (
    basename(installPath) !== expectedVersion ||
    basename(dirname(installPath)) !== pluginName ||
    basename(dirname(dirname(installPath))) !== marketplaceName
  ) {
    return invalid("Claude managed plugin cache path is inconsistent");
  }
  return {
    pluginId,
    pluginName,
    marketplaceName,
    version: expectedVersion,
    scope: "user",
    installPath,
    installedEntryHash: digest(match),
    installed: true,
    enabled: true,
  };
}

async function queryInstalledPlugin(
  executablePath: string,
  expectedVersion: string,
  runner: HostCommandRunner,
): Promise<InstalledClaudePlugin | undefined> {
  const result = await runner.run(executablePath, ["plugin", "list", "--json"]);
  if (!commandSucceeded(result)) {
    return failed("Claude plugin discovery failed");
  }
  return parseListOutput(result.stdout, expectedVersion);
}

function validateDependencies(
  catalog: AppliedClaudeMarketplaceCatalogChange,
  registration: AppliedClaudeMarketplaceRegistration,
): void {
  if (
    catalog.marketplaceName !== marketplaceName ||
    catalog.pluginName !== pluginName ||
    registration.marketplaceName !== marketplaceName ||
    !samePath(catalog.marketplaceRoot, registration.marketplaceRoot)
  ) {
    return invalid("Claude activation dependencies are inconsistent");
  }
}

function validateChange(change: AppliedClaudeActivationChange): void {
  if (
    change.kind !== "claude-cli-plugin" ||
    !isAbsolute(change.executablePath) ||
    change.pluginId !== pluginId ||
    change.pluginName !== pluginName ||
    change.marketplaceName !== marketplaceName ||
    !boundedTextPattern.test(change.version) ||
    change.scope !== "user" ||
    !isAbsolute(change.installPath) ||
    basename(change.installPath) !== change.version ||
    basename(dirname(change.installPath)) !== pluginName ||
    basename(dirname(dirname(change.installPath))) !== marketplaceName ||
    !digestPattern.test(change.installedEntryHash) ||
    typeof change.changed !== "boolean" ||
    change.installed !== true ||
    change.enabled !== true
  ) {
    return invalid("Claude activation evidence is invalid");
  }
}

function sameInstalledPlugin(
  current: InstalledClaudePlugin,
  expected: AppliedClaudeActivationChange,
): boolean {
  return current.pluginId === expected.pluginId &&
    current.version === expected.version &&
    current.scope === expected.scope &&
    samePath(current.installPath, expected.installPath) &&
    current.installedEntryHash === expected.installedEntryHash;
}

export async function applyClaudePluginActivation(
  catalog: AppliedClaudeMarketplaceCatalogChange,
  registration: AppliedClaudeMarketplaceRegistration,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<AppliedClaudeActivationChange> {
  validateDependencies(catalog, registration);
  await verifyClaudeMarketplaceCatalog(catalog);
  await verifyClaudeMarketplaceRegistration(registration, runner);
  const executablePath = registration.executablePath;

  let before: InstalledClaudePlugin | undefined;
  try {
    before = await queryInstalledPlugin(
      executablePath,
      catalog.pluginVersion,
      runner,
    );
  } catch (error) {
    if (
      error instanceof InstallerError &&
      (error.code === "CLAUDE_ACTIVATION_INVALID" ||
        error.code === "CLAUDE_ACTIVATION_CONFLICT")
    ) {
      throw error;
    }
    return failed("Claude installed plugin state could not be inspected");
  }
  if (before !== undefined) {
    return {
      kind: "claude-cli-plugin",
      executablePath,
      ...before,
      changed: false,
    };
  }

  let installFailed = false;
  try {
    const result = await runner.run(
      executablePath,
      ["plugin", "install", pluginId, "--scope", "user"],
      60_000,
    );
    installFailed = !commandSucceeded(result);
  } catch {
    installFailed = true;
  }

  let installed: InstalledClaudePlugin | undefined;
  try {
    installed = await queryInstalledPlugin(
      executablePath,
      catalog.pluginVersion,
      runner,
    );
  } catch {
    return outcomeUnknown(
      "Claude plugin installation was attempted but its resulting state could not be inspected",
    );
  }
  if (installed === undefined) {
    return failed(
      installFailed
        ? "Claude plugin install failed and the plugin is not installed"
        : "Claude plugin install completed without installing the plugin",
    );
  }
  return {
    kind: "claude-cli-plugin",
    executablePath,
    ...installed,
    changed: true,
  };
}

export async function verifyClaudePluginActivation(
  change: AppliedClaudeActivationChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateChange(change);
  let current: InstalledClaudePlugin | undefined;
  try {
    current = await queryInstalledPlugin(
      change.executablePath,
      change.version,
      runner,
    );
  } catch {
    return conflict("Claude plugin activation could not be verified");
  }
  if (current === undefined || !sameInstalledPlugin(current, change)) {
    return conflict("Claude plugin activation changed before verification");
  }
}

export async function inspectClaudePluginActivationRollback(
  change: AppliedClaudeActivationChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<ClaudeActivationRollbackStatus> {
  validateChange(change);
  if (!change.changed) {
    return "unowned";
  }
  let current: InstalledClaudePlugin | undefined;
  try {
    current = await queryInstalledPlugin(
      change.executablePath,
      change.version,
      runner,
    );
  } catch {
    return rollbackConflict(
      "Claude plugin state could not be inspected before rollback",
    );
  }
  if (current === undefined) {
    return "removed";
  }
  if (!sameInstalledPlugin(current, change)) {
    return rollbackConflict(
      "Claude plugin changed after installation; refusing to remove it",
    );
  }
  return "installed";
}

export async function rollbackClaudePluginActivation(
  change: AppliedClaudeActivationChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateChange(change);
  if (!change.changed) {
    return;
  }
  const status = await inspectClaudePluginActivationRollback(change, runner);
  if (status === "removed") {
    return;
  }

  try {
    await runner.run(
      change.executablePath,
      [
        "plugin",
        "uninstall",
        change.pluginId,
        "--scope",
        "user",
        "--keep-data",
      ],
      60_000,
    );
  } catch {
    // The postcondition below is authoritative even when the command reports an error.
  }

  let after: InstalledClaudePlugin | undefined;
  try {
    after = await queryInstalledPlugin(
      change.executablePath,
      change.version,
      runner,
    );
  } catch {
    return rollbackConflict("Claude plugin rollback outcome could not be inspected");
  }
  if (after !== undefined) {
    return rollbackConflict("Claude plugin remains installed after rollback");
  }
}
