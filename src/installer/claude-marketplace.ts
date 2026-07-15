import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { InstallerError } from "./errors.js";
import { isSafePluginVersion } from "./install-manifest.js";

const pluginName = "huaweicloud-mate";
const marketplaceName = "huaweicloud-mate-local";
const sourcePath = "./huaweicloud-mate";
const maxCatalogBytes = 64 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const boundedTextPattern = /^.{1,256}$/u;

export interface ClaudeMarketplaceCatalogPlan {
  readonly kind: "claude-local-marketplace-catalog";
  readonly marketplaceRoot: string;
  readonly manifestPath: string;
  readonly marketplaceName: typeof marketplaceName;
  readonly pluginPath: string;
  readonly pluginName: typeof pluginName;
  readonly pluginVersion: string;
  readonly sourcePath: typeof sourcePath;
}

export interface AppliedClaudeMarketplaceCatalogChange
  extends ClaudeMarketplaceCatalogPlan {
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly createdPaths: readonly string[];
}

export type ClaudeMarketplaceCatalogRollbackStatus =
  | "installed"
  | "removed"
  | "unowned";

export interface AppliedClaudeMarketplaceRegistration {
  readonly kind: "claude-cli-marketplace";
  readonly executablePath: string;
  readonly marketplaceRoot: string;
  readonly marketplaceName: typeof marketplaceName;
  readonly source: string;
  readonly installedEntryHash: string;
  readonly changed: boolean;
  readonly registered: true;
}

export type ClaudeMarketplaceRegistrationRollbackStatus =
  | "registered"
  | "removed"
  | "unowned";

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
}

interface MarketplaceEntry {
  readonly name: string;
  readonly source: string;
  readonly path: string;
  readonly installedEntryHash: string;
}

async function cleanupCatalogDirectories(
  change: AppliedClaudeMarketplaceCatalogChange,
): Promise<void> {
  for (const path of [...change.createdPaths].reverse()) {
    if (samePath(path, change.manifestPath)) {
      continue;
    }
    try {
      await rmdir(path);
    } catch {
      // Preserve non-empty, externally changed, or already absent directories.
    }
  }
}

function invalid(message: string): never {
  throw new InstallerError("CLAUDE_MARKETPLACE_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("CLAUDE_MARKETPLACE_CONFLICT", message);
}

function failed(message: string): never {
  throw new InstallerError("CLAUDE_MARKETPLACE_FAILED", message);
}

function outcomeUnknown(message: string): never {
  throw new InstallerError("CLAUDE_MARKETPLACE_OUTCOME_UNKNOWN", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("CLAUDE_MARKETPLACE_ROLLBACK_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyPresent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
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
        return invalid("Claude marketplace output contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Claude marketplace output contains a cycle");
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
      return invalid("Claude marketplace output contains a non-JSON value");
  }
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(value), "utf8")
    .digest("hex")}`;
}

function decodeJson(bytes: Uint8Array, description: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(`${description} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid(`${description} is not valid JSON`);
  }
}

function validatePlan(plan: ClaudeMarketplaceCatalogPlan): void {
  const marketplaceRoot = resolve(plan.marketplaceRoot);
  const pluginPath = resolve(plan.pluginPath);
  if (
    plan.kind !== "claude-local-marketplace-catalog" ||
    !isAbsolute(plan.marketplaceRoot) ||
    !isAbsolute(plan.manifestPath) ||
    !isAbsolute(plan.pluginPath) ||
    plan.marketplaceName !== marketplaceName ||
    plan.pluginName !== pluginName ||
    plan.sourcePath !== sourcePath ||
    !isSafePluginVersion(plan.pluginVersion) ||
    basename(pluginPath) !== pluginName ||
    !samePath(dirname(pluginPath), marketplaceRoot) ||
    basename(marketplaceRoot) !== "claude" ||
    basename(dirname(marketplaceRoot)) !== "hosts" ||
    !samePath(
      plan.manifestPath,
      resolve(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    )
  ) {
    return invalid("Claude marketplace catalog plan is invalid");
  }
}

async function validatePlugin(plan: ClaudeMarketplaceCatalogPlan): Promise<void> {
  const pluginEntry = await lstat(plan.pluginPath);
  if (!pluginEntry.isDirectory() || pluginEntry.isSymbolicLink()) {
    return invalid("Claude marketplace plugin source is not a regular directory");
  }
  const manifestPath = resolve(plan.pluginPath, ".claude-plugin", "plugin.json");
  const manifestEntry = await lstat(manifestPath);
  if (
    !manifestEntry.isFile() ||
    manifestEntry.isSymbolicLink() ||
    manifestEntry.size > maxCatalogBytes
  ) {
    return invalid("Claude plugin manifest is not a bounded regular file");
  }
  const manifest = decodeJson(await readFile(manifestPath), "Claude plugin manifest");
  if (
    !isRecord(manifest) ||
    manifest.name !== pluginName ||
    manifest.version !== plan.pluginVersion
  ) {
    return invalid("Claude plugin manifest identity does not match the catalog");
  }
}

function renderCatalog(plan: ClaudeMarketplaceCatalogPlan): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        name: marketplaceName,
        owner: { name: "hd-vector" },
        plugins: [
          {
            name: pluginName,
            source: sourcePath,
            description:
              "Guarded Huawei Cloud capability discovery, previews, and execution through a local MCP Router.",
            version: plan.pluginVersion,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function createClaudeMarketplaceCatalogPlan(
  pluginPath: string,
  pluginVersion: string,
): ClaudeMarketplaceCatalogPlan {
  if (!isAbsolute(pluginPath)) {
    return invalid("Claude marketplace plugin path must be absolute");
  }
  const resolvedPluginPath = resolve(pluginPath);
  const marketplaceRoot = dirname(resolvedPluginPath);
  const plan: ClaudeMarketplaceCatalogPlan = {
    kind: "claude-local-marketplace-catalog",
    marketplaceRoot,
    manifestPath: resolve(
      marketplaceRoot,
      ".claude-plugin",
      "marketplace.json",
    ),
    marketplaceName,
    pluginPath: resolvedPluginPath,
    pluginName,
    pluginVersion,
    sourcePath,
  };
  validatePlan(plan);
  return plan;
}

export function expectedClaudeMarketplaceCatalogSha256(
  plan: ClaudeMarketplaceCatalogPlan,
): string {
  validatePlan(plan);
  return digest(renderCatalog(plan));
}

async function readSnapshot(path: string): Promise<FileSnapshot> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return { exists: false };
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxCatalogBytes) {
    return invalid("Claude marketplace catalog must be a bounded regular file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size || bytes.byteLength > maxCatalogBytes) {
    return invalid("Claude marketplace catalog changed while it was read");
  }
  return { exists: true, bytes, sha256: digest(bytes) };
}

async function ensureManifestDirectory(plan: ClaudeMarketplaceCatalogPlan): Promise<boolean> {
  const directory = dirname(plan.manifestPath);
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return invalid("Claude marketplace manifest parent is not a regular directory");
    }
    return false;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    return true;
  } catch (error) {
    if (!isAlreadyPresent(error)) {
      throw error;
    }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return invalid("Claude marketplace manifest parent changed during creation");
    }
    return false;
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function commitCatalog(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    await writeExclusive(temporaryPath, bytes);
    if ((await readSnapshot(path)).exists) {
      return conflict("Claude marketplace catalog appeared during the transaction");
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isAlreadyPresent(error)) {
        return conflict("Claude marketplace catalog appeared during the transaction");
      }
      throw error;
    }
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function applyClaudeMarketplaceCatalog(
  plan: ClaudeMarketplaceCatalogPlan,
): Promise<AppliedClaudeMarketplaceCatalogChange> {
  let createdDirectory = false;
  try {
    validatePlan(plan);
    await validatePlugin(plan);
    const bytes = renderCatalog(plan);
    const installedSha256 = digest(bytes);
    createdDirectory = await ensureManifestDirectory(plan);
    const before = await readSnapshot(plan.manifestPath);
    if (before.exists) {
      if (before.sha256 !== installedSha256) {
        return conflict("Claude marketplace catalog already contains different content");
      }
      return {
        ...plan,
        changed: false,
        createdFile: false,
        installedSha256,
        createdPaths: [],
      };
    }
    await commitCatalog(plan.manifestPath, bytes);
    return {
      ...plan,
      changed: true,
      createdFile: true,
      installedSha256,
      createdPaths: [
        ...(createdDirectory ? [dirname(plan.manifestPath)] : []),
        plan.manifestPath,
      ],
    };
  } catch (error) {
    if (createdDirectory) {
      try {
        await rmdir(dirname(plan.manifestPath));
      } catch {
        // Preserve a directory that acquired content during the transaction.
      }
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "CLAUDE_MARKETPLACE_FAILED",
      "Claude marketplace catalog transaction failed",
    );
  }
}

function validateCatalogChange(change: AppliedClaudeMarketplaceCatalogChange): void {
  validatePlan(change);
  if (
    typeof change.changed !== "boolean" ||
    change.createdFile !== change.changed ||
    !digestPattern.test(change.installedSha256) ||
    change.createdPaths.some((path) => !isAbsolute(path)) ||
    (change.changed &&
      !change.createdPaths.some((path) => samePath(path, change.manifestPath))) ||
    (!change.changed && change.createdPaths.length > 0) ||
    change.createdPaths.some(
      (path) =>
        !samePath(path, change.manifestPath) &&
        !samePath(path, dirname(change.manifestPath)) &&
        !isContained(dirname(change.manifestPath), path),
    )
  ) {
    return invalid("Claude marketplace catalog change evidence is invalid");
  }
}

export async function verifyClaudeMarketplaceCatalog(
  change: AppliedClaudeMarketplaceCatalogChange,
): Promise<void> {
  validateCatalogChange(change);
  await validatePlugin(change);
  const snapshot = await readSnapshot(change.manifestPath);
  if (!snapshot.exists || snapshot.sha256 !== change.installedSha256) {
    return conflict("Claude marketplace catalog changed before verification");
  }
  if (digest(renderCatalog(change)) !== change.installedSha256) {
    return invalid("Claude marketplace catalog evidence is inconsistent");
  }
}

export async function inspectClaudeMarketplaceCatalogRollback(
  change: AppliedClaudeMarketplaceCatalogChange,
): Promise<ClaudeMarketplaceCatalogRollbackStatus> {
  validateCatalogChange(change);
  if (!change.changed) {
    return "unowned";
  }
  const snapshot = await readSnapshot(change.manifestPath);
  if (!snapshot.exists) {
    return "removed";
  }
  if (snapshot.sha256 !== change.installedSha256) {
    return rollbackConflict(
      "Claude marketplace catalog changed after registration; refusing to remove it",
    );
  }
  return "installed";
}

async function restoreQuarantine(
  quarantinePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    await link(quarantinePath, targetPath);
    await unlink(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

export async function rollbackClaudeMarketplaceCatalog(
  change: AppliedClaudeMarketplaceCatalogChange,
): Promise<void> {
  validateCatalogChange(change);
  if (!change.changed) {
    return;
  }
  let quarantinePath: string | undefined;
  try {
    const status = await inspectClaudeMarketplaceCatalogRollback(change);
    if (status === "removed") {
      await cleanupCatalogDirectories(change);
      return;
    }
    quarantinePath = resolve(
      dirname(change.manifestPath),
      `.${basename(change.manifestPath)}.${randomBytes(16).toString("hex")}.rollback`,
    );
    await rename(change.manifestPath, quarantinePath);
    const captured = await readSnapshot(quarantinePath);
    if (captured.sha256 !== change.installedSha256) {
      if (await restoreQuarantine(quarantinePath, change.manifestPath)) {
        quarantinePath = undefined;
      }
      return rollbackConflict(
        "Claude marketplace catalog changed during rollback; user content was preserved",
      );
    }
    await rm(quarantinePath, { force: true });
    quarantinePath = undefined;
    await cleanupCatalogDirectories(change);
  } catch (error) {
    if (quarantinePath !== undefined) {
      if (await restoreQuarantine(quarantinePath, change.manifestPath)) {
        quarantinePath = undefined;
      }
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "CLAUDE_MARKETPLACE_FAILED",
      "Claude marketplace catalog rollback failed",
    );
  }
}

function commandSucceeded(result: HostCommandResult): boolean {
  return result.code === 0 && result.signal === null;
}

function parseMarketplaceList(stdout: string): MarketplaceEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return invalid("Claude marketplace list did not return valid JSON");
  }
  if (!Array.isArray(value)) {
    return invalid("Claude marketplace list JSON must be an array");
  }
  const matches: Record<string, unknown>[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      !boundedTextPattern.test(candidate.name)
    ) {
      return invalid("Claude marketplace list contains an invalid entry");
    }
    if (candidate.name === marketplaceName) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    return conflict("Claude lists duplicate managed marketplace identities");
  }
  const match = matches[0]!;
  if (
    typeof match.source !== "string" ||
    !boundedTextPattern.test(match.source) ||
    typeof match.path !== "string" ||
    !isAbsolute(match.path) ||
    (match.installLocation !== undefined &&
      (typeof match.installLocation !== "string" ||
        !isAbsolute(match.installLocation) ||
        !samePath(match.installLocation, match.path)))
  ) {
    return invalid("Claude managed marketplace entry is incomplete");
  }
  return {
    name: marketplaceName,
    source: match.source,
    path: resolve(match.path),
    installedEntryHash: digestJson(match),
  };
}

async function queryMarketplace(
  executablePath: string,
  runner: HostCommandRunner,
): Promise<MarketplaceEntry | undefined> {
  const result = await runner.run(
    executablePath,
    ["plugin", "marketplace", "list", "--json"],
  );
  if (!commandSucceeded(result)) {
    return failed("Claude marketplace discovery failed");
  }
  return parseMarketplaceList(result.stdout);
}

function validateRegistration(
  change: AppliedClaudeMarketplaceRegistration,
): void {
  if (
    change.kind !== "claude-cli-marketplace" ||
    !isAbsolute(change.executablePath) ||
    !isAbsolute(change.marketplaceRoot) ||
    basename(change.marketplaceRoot) !== "claude" ||
    basename(dirname(change.marketplaceRoot)) !== "hosts" ||
    change.marketplaceName !== marketplaceName ||
    !boundedTextPattern.test(change.source) ||
    !digestPattern.test(change.installedEntryHash) ||
    typeof change.changed !== "boolean" ||
    change.registered !== true
  ) {
    return invalid("Claude marketplace registration evidence is invalid");
  }
}

export async function applyClaudeMarketplaceRegistration(
  catalog: AppliedClaudeMarketplaceCatalogChange,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<AppliedClaudeMarketplaceRegistration> {
  await verifyClaudeMarketplaceCatalog(catalog);
  let executablePath: string | undefined;
  try {
    executablePath = await runner.resolveCommand("claude");
  } catch {
    return failed("Claude command discovery failed");
  }
  if (executablePath === undefined) {
    return failed("Claude command was not found");
  }
  if (!isAbsolute(executablePath)) {
    return invalid("Claude command path is not absolute");
  }
  let validation: HostCommandResult;
  try {
    validation = await runner.run(
      executablePath,
      ["plugin", "validate", catalog.marketplaceRoot],
      60_000,
    );
  } catch {
    return failed("Claude marketplace validation command failed");
  }
  if (!commandSucceeded(validation)) {
    return failed("Claude rejected the local marketplace catalog");
  }

  let before: MarketplaceEntry | undefined;
  try {
    before = await queryMarketplace(executablePath, runner);
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    return failed("Claude marketplace state could not be inspected");
  }
  if (before !== undefined) {
    if (!samePath(before.path, catalog.marketplaceRoot)) {
      return conflict("Claude marketplace name already points to a different source");
    }
    return {
      kind: "claude-cli-marketplace",
      executablePath,
      marketplaceRoot: catalog.marketplaceRoot,
      marketplaceName,
      source: before.source,
      installedEntryHash: before.installedEntryHash,
      changed: false,
      registered: true,
    };
  }

  let addFailed = false;
  try {
    const result = await runner.run(
      executablePath,
      [
        "plugin",
        "marketplace",
        "add",
        catalog.marketplaceRoot,
        "--scope",
        "user",
      ],
      60_000,
    );
    addFailed = !commandSucceeded(result);
  } catch {
    addFailed = true;
  }
  let installed: MarketplaceEntry | undefined;
  try {
    installed = await queryMarketplace(executablePath, runner);
  } catch {
    return outcomeUnknown(
      "Claude marketplace registration was attempted but its resulting state could not be inspected",
    );
  }
  if (installed === undefined) {
    return failed(
      addFailed
        ? "Claude marketplace add failed and the marketplace is not registered"
        : "Claude marketplace add completed without registering the marketplace",
    );
  }
  if (!samePath(installed.path, catalog.marketplaceRoot)) {
    return conflict("Claude registered the managed marketplace with a different source");
  }
  return {
    kind: "claude-cli-marketplace",
    executablePath,
    marketplaceRoot: catalog.marketplaceRoot,
    marketplaceName,
    source: installed.source,
    installedEntryHash: installed.installedEntryHash,
    changed: true,
    registered: true,
  };
}

export async function verifyClaudeMarketplaceRegistration(
  change: AppliedClaudeMarketplaceRegistration,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateRegistration(change);
  let current: MarketplaceEntry | undefined;
  try {
    current = await queryMarketplace(change.executablePath, runner);
  } catch {
    return conflict("Claude marketplace registration could not be verified");
  }
  if (
    current === undefined ||
    !samePath(current.path, change.marketplaceRoot) ||
    current.source !== change.source ||
    current.installedEntryHash !== change.installedEntryHash
  ) {
    return conflict("Claude marketplace registration changed before verification");
  }
}

export async function inspectClaudeMarketplaceRegistrationRollback(
  change: AppliedClaudeMarketplaceRegistration,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<ClaudeMarketplaceRegistrationRollbackStatus> {
  validateRegistration(change);
  if (!change.changed) {
    return "unowned";
  }
  let current: MarketplaceEntry | undefined;
  try {
    current = await queryMarketplace(change.executablePath, runner);
  } catch {
    return rollbackConflict(
      "Claude marketplace state could not be inspected before rollback",
    );
  }
  if (current === undefined) {
    return "removed";
  }
  if (
    !samePath(current.path, change.marketplaceRoot) ||
    current.source !== change.source ||
    current.installedEntryHash !== change.installedEntryHash
  ) {
    return rollbackConflict(
      "Claude marketplace changed after registration; refusing to remove it",
    );
  }
  return "registered";
}

export async function rollbackClaudeMarketplaceRegistration(
  change: AppliedClaudeMarketplaceRegistration,
  runner: HostCommandRunner = new NodeHostCommandRunner(),
): Promise<void> {
  validateRegistration(change);
  if (!change.changed) {
    return;
  }
  const status = await inspectClaudeMarketplaceRegistrationRollback(
    change,
    runner,
  );
  if (status === "removed") {
    return;
  }
  try {
    await runner.run(
      change.executablePath,
      ["plugin", "marketplace", "remove", change.marketplaceName],
      60_000,
    );
  } catch {
    // The postcondition below is authoritative even when the command reports an error.
  }
  let after: MarketplaceEntry | undefined;
  try {
    after = await queryMarketplace(change.executablePath, runner);
  } catch {
    return rollbackConflict(
      "Claude marketplace rollback outcome could not be inspected",
    );
  }
  if (after !== undefined) {
    return rollbackConflict("Claude marketplace remains registered after rollback");
  }
}
