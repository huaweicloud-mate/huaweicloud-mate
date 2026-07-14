import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  getNodeValue,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";

import { InstallerError } from "./errors.js";

const pluginName = "huaweicloud-mate";
const sourcePath = "./plugins/huaweicloud-mate";
const defaultMarketplaceName = "personal";
const maxMarketplaceBytes = 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const marketplaceNamePattern = /^[A-Za-z0-9._-]{1,64}$/u;

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
  readonly mode?: number;
}

export interface CodexMarketplacePlan {
  readonly marketplacePath: string;
  readonly pluginPath: string;
  readonly pluginName: "huaweicloud-mate";
  readonly sourcePath: "./plugins/huaweicloud-mate";
}

export interface AppliedCodexMarketplaceChange extends CodexMarketplacePlan {
  readonly marketplaceName: string;
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly installedEntryHash: string;
  readonly beforeSha256?: string;
  readonly backupPath?: string;
  readonly backupSha256?: string;
}

export type CodexMarketplaceRollbackStatus =
  | "installed"
  | "restored"
  | "unowned";

function invalid(message: string): never {
  throw new InstallerError("CODEX_MARKETPLACE_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("CODEX_MARKETPLACE_CONFLICT", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("CODEX_MARKETPLACE_ROLLBACK_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
        return invalid("Codex marketplace contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Codex marketplace contains a cycle");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          return invalid("Codex marketplace contains a non-JSON object");
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
      return invalid("Codex marketplace contains a non-JSON value");
  }
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function desiredEntry(): Record<string, unknown> {
  return {
    name: pluginName,
    source: {
      source: "local",
      path: sourcePath,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

function assertNoDuplicateProperties(node: Node): void {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as unknown;
      if (typeof key !== "string" || names.has(key)) {
        return invalid("Codex marketplace contains a duplicate or invalid property");
      }
      names.add(key);
    }
  }
  for (const child of node.children ?? []) {
    assertNoDuplicateProperties(child);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Codex marketplace is not valid UTF-8");
  }
}

function parseJsonObject(bytes: Uint8Array, description: string): Record<string, unknown> {
  const text = decodeUtf8(bytes);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree === undefined || errors.length > 0 || tree.type !== "object") {
    return invalid(`${description} is not a strict JSON object`);
  }
  assertNoDuplicateProperties(tree);
  const value = getNodeValue(tree) as unknown;
  if (!isRecord(value)) {
    return invalid(`${description} root is invalid`);
  }
  return value;
}

function marketplaceName(value: Record<string, unknown>): string {
  const name = value.name;
  if (typeof name !== "string" || !marketplaceNamePattern.test(name)) {
    return invalid("Codex marketplace name is invalid");
  }
  if (value.interface !== undefined && !isRecord(value.interface)) {
    return invalid("Codex marketplace interface is invalid");
  }
  return name;
}

function marketplacePlugins(value: Record<string, unknown>): Record<string, unknown>[] {
  const plugins = value.plugins;
  if (plugins === undefined) {
    return [];
  }
  if (!Array.isArray(plugins)) {
    return invalid("Codex marketplace plugins value is not an array");
  }
  const names = new Set<string>();
  return plugins.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      return invalid("Codex marketplace contains an invalid plugin entry");
    }
    if (names.has(entry.name)) {
      return invalid("Codex marketplace contains duplicate plugin names");
    }
    names.add(entry.name);
    return entry;
  });
}

function renderMarketplace(original?: FileSnapshot): {
  readonly marketplaceName: string;
  readonly changed: boolean;
  readonly bytes: Buffer;
} {
  const entry = desiredEntry();
  if (original?.bytes === undefined) {
    const value = {
      name: defaultMarketplaceName,
      interface: { displayName: "Personal" },
      plugins: [entry],
    };
    return {
      marketplaceName: defaultMarketplaceName,
      changed: true,
      bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    };
  }
  const value = parseJsonObject(original.bytes, "Codex marketplace");
  const name = marketplaceName(value);
  const plugins = marketplacePlugins(value);
  const existing = plugins.find((candidate) => candidate.name === pluginName);
  if (existing !== undefined) {
    if (canonicalize(existing) !== canonicalize(entry)) {
      return conflict("Codex marketplace already contains a different plugin entry");
    }
    return { marketplaceName: name, changed: false, bytes: original.bytes };
  }
  const rendered = {
    ...canonicalClone(value),
    plugins: [...plugins.map((candidate) => canonicalClone(candidate)), entry],
  };
  return {
    marketplaceName: name,
    changed: true,
    bytes: Buffer.from(`${JSON.stringify(rendered, null, 2)}\n`, "utf8"),
  };
}

async function readSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > maxMarketplaceBytes
    ) {
      return invalid("Codex marketplace must be a regular non-symlink file");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxMarketplaceBytes) {
      return invalid("Codex marketplace exceeds the size limit");
    }
    return {
      exists: true,
      bytes,
      sha256: digest(bytes),
      mode: entry.mode & 0o777,
    };
  } catch (error) {
    if (isMissing(error)) {
      return { exists: false };
    }
    throw error;
  }
}

function snapshotMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists &&
    (!left.exists || left.sha256 === right.sha256);
}

async function ensureDirectory(path: string, privateDirectory: boolean): Promise<void> {
  let existed = true;
  try {
    await lstat(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    existed = false;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return invalid("Codex marketplace transaction directory is invalid");
  }
  if (privateDirectory) {
    if (existed && process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
      return invalid("Codex marketplace backup directory is not private");
    }
    if (!existed) {
      await chmod(path, 0o700);
    }
  }
}

async function writeExclusive(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function atomicReplace(
  path: string,
  bytes: Uint8Array,
  mode: number,
  expected: FileSnapshot,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    await writeExclusive(temporaryPath, bytes, mode);
    const current = await readSnapshot(path);
    if (!snapshotMatches(current, expected)) {
      return conflict("Codex marketplace changed during the transaction");
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function createBackup(
  marketplacePath: string,
  backupDirectory: string,
  original: FileSnapshot,
): Promise<string> {
  if (!original.exists || original.bytes === undefined) {
    return invalid("Cannot back up a missing Codex marketplace");
  }
  await ensureDirectory(backupDirectory, true);
  const safeName = basename(marketplacePath).replace(/[^A-Za-z0-9._-]/gu, "_");
  const backupPath = resolve(
    backupDirectory,
    `${safeName}.${randomBytes(16).toString("hex")}.bak`,
  );
  try {
    await writeExclusive(backupPath, original.bytes, 0o600);
  } catch (error) {
    await rm(backupPath, { force: true });
    throw error;
  }
  return backupPath;
}

async function verifyPluginPath(plan: CodexMarketplacePlan): Promise<void> {
  const root = await lstat(plan.pluginPath).catch((error: unknown) => {
    if (isMissing(error)) {
      return invalid("Codex plugin source does not exist");
    }
    throw error;
  });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return invalid("Codex plugin source must be a regular directory");
  }
  const manifestPath = resolve(plan.pluginPath, ".codex-plugin", "plugin.json");
  const manifest = await readSnapshot(manifestPath);
  if (!manifest.exists || manifest.bytes === undefined) {
    return invalid("Codex plugin manifest does not exist");
  }
  const value = parseJsonObject(manifest.bytes, "Codex plugin manifest");
  if (value.name !== pluginName) {
    return invalid("Codex plugin manifest identity is invalid");
  }
}

function validatePlan(plan: CodexMarketplacePlan): void {
  if (
    !isAbsolute(plan.marketplacePath) ||
    !isAbsolute(plan.pluginPath) ||
    plan.pluginName !== pluginName ||
    plan.sourcePath !== sourcePath ||
    basename(plan.pluginPath) !== pluginName ||
    basename(dirname(plan.pluginPath)) !== "plugins"
  ) {
    return invalid("Codex marketplace plan is invalid");
  }
  const homeDirectory = dirname(dirname(plan.pluginPath));
  if (
    resolve(plan.marketplacePath) !==
      resolve(homeDirectory, ".agents", "plugins", "marketplace.json")
  ) {
    return invalid("Codex marketplace path does not match the personal layout");
  }
}

export function createCodexMarketplacePlan(pluginPath: string): CodexMarketplacePlan {
  if (!isAbsolute(pluginPath)) {
    return invalid("Codex plugin path must be absolute");
  }
  const resolvedPluginPath = resolve(pluginPath);
  const homeDirectory = dirname(dirname(resolvedPluginPath));
  const plan: CodexMarketplacePlan = {
    marketplacePath: resolve(
      homeDirectory,
      ".agents",
      "plugins",
      "marketplace.json",
    ),
    pluginPath: resolvedPluginPath,
    pluginName,
    sourcePath,
  };
  validatePlan(plan);
  return plan;
}

export async function applyCodexMarketplaceChange(
  plan: CodexMarketplacePlan,
  backupDirectory: string,
): Promise<AppliedCodexMarketplaceChange> {
  try {
    validatePlan(plan);
    if (!isAbsolute(backupDirectory)) {
      return invalid("Codex marketplace backup path must be absolute");
    }
    await verifyPluginPath(plan);
    const original = await readSnapshot(plan.marketplacePath);
    const rendered = renderMarketplace(original);
    if (rendered.bytes.byteLength > maxMarketplaceBytes) {
      return invalid("Rendered Codex marketplace exceeds the size limit");
    }
    const installedSha256 = digest(rendered.bytes);
    const installedEntryHash = digest(
      Buffer.from(canonicalize(desiredEntry()), "utf8"),
    );
    if (!rendered.changed) {
      return {
        ...plan,
        marketplaceName: rendered.marketplaceName,
        changed: false,
        createdFile: false,
        installedSha256,
        installedEntryHash,
        ...(original.sha256 === undefined ? {} : { beforeSha256: original.sha256 }),
      };
    }

    await ensureDirectory(dirname(plan.marketplacePath), false);
    let backupPath: string | undefined;
    try {
      if (original.exists) {
        backupPath = await createBackup(
          plan.marketplacePath,
          backupDirectory,
          original,
        );
      }
      await atomicReplace(
        plan.marketplacePath,
        rendered.bytes,
        original.mode ?? 0o600,
        original,
      );
    } catch (error) {
      if (backupPath !== undefined) {
        await rm(backupPath, { force: true });
      }
      throw error;
    }
    return {
      ...plan,
      marketplaceName: rendered.marketplaceName,
      changed: true,
      createdFile: !original.exists,
      installedSha256,
      installedEntryHash,
      ...(original.sha256 === undefined ? {} : { beforeSha256: original.sha256 }),
      ...(backupPath === undefined
        ? {}
        : { backupPath, backupSha256: original.sha256 }),
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "CODEX_MARKETPLACE_WRITE_FAILED",
      "Codex marketplace transaction failed",
    );
  }
}

export async function verifyCodexMarketplaceChange(
  change: AppliedCodexMarketplaceChange,
): Promise<void> {
  try {
    validatePlan(change);
    if (
      !marketplaceNamePattern.test(change.marketplaceName) ||
      !digestPattern.test(change.installedSha256) ||
      !digestPattern.test(change.installedEntryHash)
    ) {
      return invalid("Codex marketplace verification evidence is invalid");
    }
    await verifyPluginPath(change);
    const current = await readSnapshot(change.marketplacePath);
    if (
      !current.exists ||
      current.bytes === undefined ||
      current.sha256 !== change.installedSha256
    ) {
      return conflict("Codex marketplace changed before verification");
    }
    const value = parseJsonObject(current.bytes, "Codex marketplace");
    if (marketplaceName(value) !== change.marketplaceName) {
      return conflict("Codex marketplace name changed before verification");
    }
    const entry = marketplacePlugins(value).find(
      (candidate) => candidate.name === pluginName,
    );
    if (
      entry === undefined ||
      digest(Buffer.from(canonicalize(entry), "utf8")) !==
        change.installedEntryHash
    ) {
      return conflict("Codex marketplace entry changed before verification");
    }
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "CODEX_MARKETPLACE_WRITE_FAILED",
      "Codex marketplace verification failed",
    );
  }
}

export async function rollbackCodexMarketplaceChange(
  change: AppliedCodexMarketplaceChange,
): Promise<void> {
  if (!change.changed) {
    return;
  }
  try {
    validatePlan(change);
    const current = await readSnapshot(change.marketplacePath);
    if (change.createdFile && !current.exists) {
      return;
    }
    if (
      !change.createdFile &&
      current.exists &&
      current.sha256 === change.beforeSha256
    ) {
      return;
    }
    if (!current.exists || current.sha256 !== change.installedSha256) {
      return rollbackConflict(
        "Codex marketplace changed after installation; refusing to roll it back",
      );
    }
    if (change.createdFile) {
      await unlink(change.marketplacePath);
      return;
    }
    if (
      change.backupPath === undefined ||
      change.backupSha256 === undefined ||
      change.beforeSha256 === undefined
    ) {
      return rollbackConflict("Codex marketplace rollback evidence is incomplete");
    }
    const backup = await readSnapshot(change.backupPath);
    if (
      !backup.exists ||
      backup.bytes === undefined ||
      backup.sha256 !== change.backupSha256 ||
      backup.sha256 !== change.beforeSha256
    ) {
      return rollbackConflict("Codex marketplace backup is missing or changed");
    }
    await atomicReplace(
      change.marketplacePath,
      backup.bytes,
      current.mode ?? 0o600,
      current,
    );
    await rm(change.backupPath, { force: true });
  } catch (error) {
    if (error instanceof InstallerError) {
      if (
        error.code === "CODEX_MARKETPLACE_CONFLICT" ||
        error.code === "CODEX_MARKETPLACE_INVALID"
      ) {
        return rollbackConflict(
          "Codex marketplace changed during rollback; refusing to overwrite it",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "CODEX_MARKETPLACE_WRITE_FAILED",
      "Codex marketplace rollback failed",
    );
  }
}

export async function inspectCodexMarketplaceRollback(
  change: AppliedCodexMarketplaceChange,
): Promise<CodexMarketplaceRollbackStatus> {
  if (!change.changed) {
    return "unowned";
  }
  try {
    validatePlan(change);
    if (
      !digestPattern.test(change.installedSha256) ||
      (change.createdFile && change.beforeSha256 !== undefined) ||
      (!change.createdFile && !digestPattern.test(change.beforeSha256 ?? ""))
    ) {
      return rollbackConflict("Codex marketplace rollback evidence is invalid");
    }
    const current = await readSnapshot(change.marketplacePath);
    if (change.createdFile && !current.exists) {
      return "restored";
    }
    if (
      !change.createdFile &&
      current.exists &&
      current.sha256 === change.beforeSha256
    ) {
      return "restored";
    }
    if (current.exists && current.sha256 === change.installedSha256) {
      if (!change.createdFile) {
        if (
          change.backupPath === undefined ||
          change.backupSha256 === undefined ||
          change.beforeSha256 === undefined
        ) {
          return rollbackConflict(
            "Codex marketplace rollback evidence is incomplete",
          );
        }
        const backup = await readSnapshot(change.backupPath);
        if (
          !backup.exists ||
          backup.sha256 !== change.backupSha256 ||
          backup.sha256 !== change.beforeSha256
        ) {
          return rollbackConflict(
            "Codex marketplace backup is missing or changed",
          );
        }
      }
      return "installed";
    }
    return rollbackConflict(
      "Codex marketplace changed after installation; refusing to roll it back",
    );
  } catch (error) {
    if (error instanceof InstallerError) {
      if (
        error.code === "CODEX_MARKETPLACE_CONFLICT" ||
        error.code === "CODEX_MARKETPLACE_INVALID"
      ) {
        return rollbackConflict(
          "Codex marketplace changed during rollback inspection",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "CODEX_MARKETPLACE_WRITE_FAILED",
      "Codex marketplace rollback inspection failed",
    );
  }
}
