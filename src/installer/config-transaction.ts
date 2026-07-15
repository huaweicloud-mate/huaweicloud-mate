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
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  type FormattingOptions,
  type Node,
  type ParseError,
} from "jsonc-parser";

import type { HostInstallPlan } from "../hosts/plan.js";
import { InstallerError } from "./errors.js";

const maxConfigBytes = 8 * 1024 * 1024;
const utf8Bom = "\uFEFF";

export type ManagedHostConfig = Pick<
  HostInstallPlan,
  "configPath" | "entryKey" | "mergeStrategy" | "configFragment"
>;

export interface AppliedHostConfigChange {
  readonly configPath: string;
  readonly entryKey: "huaweicloud-agent";
  readonly mergeStrategy: HostInstallPlan["mergeStrategy"];
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly installedValueHash: string;
  readonly beforeSha256?: string;
  readonly backupPath?: string;
  readonly backupSha256?: string;
}

export type HostConfigRollbackStatus = "unowned" | "installed" | "removed";

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
  readonly mode?: number;
}

interface ParsedConfig {
  readonly text: string;
  readonly value: Record<string, unknown>;
  readonly hadBom: boolean;
  readonly wasEmpty: boolean;
}

function invalid(message: string): never {
  throw new InstallerError("HOST_CONFIG_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("HOST_CONFIG_CONFLICT", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("HOST_CONFIG_ROLLBACK_CONFLICT", message);
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

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return invalid("Host config is not valid UTF-8");
  }
}

function canonicalizeJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        return invalid("Managed host config contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Managed host config contains a cycle");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value
            .map((item) => canonicalizeJson(item, ancestors))
            .join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          return invalid("Managed host config contains a non-JSON object");
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalizeJson(record[key], ancestors)}`,
          )
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return invalid("Managed host config contains a non-JSON value");
  }
}

function canonicalClone(value: unknown): unknown {
  return JSON.parse(canonicalizeJson(value)) as unknown;
}

function valueDigest(value: unknown): string {
  return digest(Buffer.from(canonicalizeJson(value), "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function configRootName(
  strategy: HostInstallPlan["mergeStrategy"],
): "mcp" | "mcpServers" {
  switch (strategy) {
    case "json-object":
    case "jsonc-object":
      return "mcp";
    case "plugin-manifest":
      return "mcpServers";
    case "toml-table":
      return invalid("TOML host config is not implemented in v0.3-lite");
  }
}

function desiredEntry(config: ManagedHostConfig): {
  readonly rootName: "mcp" | "mcpServers";
  readonly value: Record<string, unknown>;
} {
  const rootName = configRootName(config.mergeStrategy);
  if (
    !isRecord(config.configFragment) ||
    !exactKeys(config.configFragment, [rootName])
  ) {
    return invalid("Managed host config fragment has an unexpected root");
  }
  const root = config.configFragment[rootName];
  if (
    !isRecord(root) ||
    !exactKeys(root, [config.entryKey]) ||
    !isRecord(root[config.entryKey])
  ) {
    return invalid("Managed host config fragment has an unexpected MCP entry");
  }
  return {
    rootName,
    value: canonicalClone(root[config.entryKey]) as Record<string, unknown>,
  };
}

function assertNoDuplicateProperties(node: Node): void {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as unknown;
      if (typeof key !== "string") {
        return invalid("Host config contains an invalid object property");
      }
      if (names.has(key)) {
        return invalid("Host config contains a duplicate object property");
      }
      names.add(key);
    }
  }
  for (const child of node.children ?? []) {
    assertNoDuplicateProperties(child);
  }
}

function parseConfig(
  originalText: string,
  allowComments: boolean,
): ParsedConfig {
  const hadBom = originalText.startsWith(utf8Bom);
  const body = hadBom ? originalText.slice(1) : originalText;
  const wasEmpty = body.trim().length === 0;
  const text = wasEmpty ? "{}" : body;
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: allowComments,
    disallowComments: !allowComments,
  });
  if (tree === undefined || errors.length > 0 || tree.type !== "object") {
    return invalid("Host config is not a valid JSON object");
  }
  assertNoDuplicateProperties(tree);
  const value = getNodeValue(tree) as unknown;
  if (!isRecord(value)) {
    return invalid("Host config root is not an object");
  }
  return { text, value, hadBom, wasEmpty };
}

function formattingOptions(text: string, wasEmpty: boolean): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentation = /(?:\r?\n)([ \t]+)"/u.exec(text)?.[1] ?? "  ";
  const usesTabs = indentation.includes("\t");
  return {
    insertSpaces: !usesTabs,
    tabSize: usesTabs ? 1 : Math.max(1, indentation.length),
    eol,
    insertFinalNewline: wasEmpty || text.endsWith("\n") || text.endsWith("\r"),
  };
}

function renderMergedConfig(
  parsed: ParsedConfig,
  rootName: "mcp" | "mcpServers",
  entryKey: string,
  entryValue: Record<string, unknown>,
): { readonly changed: boolean; readonly text: string } {
  const existingRoot = parsed.value[rootName];
  if (existingRoot !== undefined && !isRecord(existingRoot)) {
    return invalid(`Host config ${rootName} value is not an object`);
  }
  const existingEntry = existingRoot?.[entryKey];
  if (existingEntry !== undefined) {
    if (canonicalizeJson(existingEntry) !== canonicalizeJson(entryValue)) {
      return conflict("Host config already contains a different managed MCP entry");
    }
    return {
      changed: false,
      text: `${parsed.hadBom ? utf8Bom : ""}${parsed.text}`,
    };
  }

  const path = existingRoot === undefined
    ? [rootName]
    : [rootName, entryKey];
  const value = existingRoot === undefined
    ? { [entryKey]: entryValue }
    : entryValue;
  const rendered = applyEdits(
    parsed.text,
    modify(parsed.text, path, value, {
      formattingOptions: formattingOptions(parsed.text, parsed.wasEmpty),
    }),
  );
  return {
    changed: true,
    text: `${parsed.hadBom ? utf8Bom : ""}${rendered}`,
  };
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
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxConfigBytes) {
    return invalid("Host config must be a regular non-symlink file within size limits");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maxConfigBytes) {
    return invalid("Host config exceeds the size limit");
  }
  return {
    exists: true,
    bytes,
    sha256: digest(bytes),
    mode: entry.mode & 0o777,
  };
}

function snapshotMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.exists === right.exists &&
    (!left.exists || left.sha256 === right.sha256)
  );
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
    return invalid("Host config transaction directory is not a regular directory");
  }
  if (privateDirectory) {
    if (existed && process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
      return invalid("Host config backup directory is not private");
    }
    if (!existed) {
      await chmod(path, 0o700);
    }
  }
}

async function writeExclusiveFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
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
    await writeExclusiveFile(temporaryPath, bytes, mode);
    const current = await readSnapshot(path);
    if (!snapshotMatches(current, expected)) {
      return conflict("Host config changed during the transaction");
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function createBackup(
  configPath: string,
  backupDirectory: string,
  original: FileSnapshot,
): Promise<string> {
  if (!original.exists || original.bytes === undefined) {
    return invalid("Cannot back up a missing host config");
  }
  await ensureDirectory(backupDirectory, true);
  const safeName = basename(configPath).replace(/[^A-Za-z0-9._-]/gu, "_");
  const backupPath = resolve(
    backupDirectory,
    `${safeName}.${randomBytes(16).toString("hex")}.bak`,
  );
  try {
    await writeExclusiveFile(backupPath, original.bytes, 0o600);
  } catch (error) {
    await rm(backupPath, { force: true });
    throw error;
  }
  return backupPath;
}

function result(
  config: ManagedHostConfig,
  changed: boolean,
  createdFile: boolean,
  installedSha256: string,
  installedValueHash: string,
  original: FileSnapshot,
  backupPath?: string,
): AppliedHostConfigChange {
  return {
    configPath: config.configPath,
    entryKey: config.entryKey,
    mergeStrategy: config.mergeStrategy,
    changed,
    createdFile,
    installedSha256,
    installedValueHash,
    ...(original.sha256 === undefined
      ? {}
      : { beforeSha256: original.sha256 }),
    ...(backupPath === undefined
      ? {}
      : { backupPath, backupSha256: original.sha256 }),
  };
}

export async function applyHostConfigChange(
  config: ManagedHostConfig,
  backupDirectory: string,
): Promise<AppliedHostConfigChange> {
  try {
    if (!isAbsolute(config.configPath) || !isAbsolute(backupDirectory)) {
      return invalid("Host config and backup paths must be absolute");
    }
    const desired = desiredEntry(config);
    const original = await readSnapshot(config.configPath);
    const originalText = original.bytes === undefined
      ? ""
      : decodeUtf8(original.bytes);
    const parsed = parseConfig(
      originalText,
      config.mergeStrategy === "jsonc-object",
    );
    const rendered = renderMergedConfig(
      parsed,
      desired.rootName,
      config.entryKey,
      desired.value,
    );
    const installedValueHash = valueDigest(desired.value);
    if (!rendered.changed) {
      if (original.sha256 === undefined) {
        return invalid("An unchanged host config must already exist");
      }
      return result(
        config,
        false,
        false,
        original.sha256,
        installedValueHash,
        original,
      );
    }

    const renderedBytes = Buffer.from(rendered.text, "utf8");
    if (renderedBytes.byteLength > maxConfigBytes) {
      return invalid("Rendered host config exceeds the size limit");
    }
    const verified = parseConfig(
      rendered.text,
      config.mergeStrategy === "jsonc-object",
    );
    const verifiedRoot = verified.value[desired.rootName];
    if (
      !isRecord(verifiedRoot) ||
      canonicalizeJson(verifiedRoot[config.entryKey]) !==
        canonicalizeJson(desired.value)
    ) {
      return invalid("Rendered host config does not contain the managed entry");
    }

    await ensureDirectory(dirname(config.configPath), false);
    let backupPath: string | undefined;
    try {
      if (original.exists) {
        backupPath = await createBackup(
          config.configPath,
          backupDirectory,
          original,
        );
      }
      await atomicReplace(
        config.configPath,
        renderedBytes,
        original.mode ?? 0o600,
        original,
      );
    } catch (error) {
      if (backupPath !== undefined) {
        await rm(backupPath, { force: true });
      }
      throw error;
    }
    return result(
      config,
      true,
      !original.exists,
      digest(renderedBytes),
      installedValueHash,
      original,
      backupPath,
    );
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "HOST_CONFIG_WRITE_FAILED",
      "Host config transaction failed",
    );
  }
}

export async function rollbackHostConfigChange(
  change: AppliedHostConfigChange,
): Promise<void> {
  if (!change.changed) {
    return;
  }
  try {
    const current = await readSnapshot(change.configPath);
    if (!current.exists || current.sha256 !== change.installedSha256) {
      return rollbackConflict(
        "Host config changed after installation; refusing to roll it back",
      );
    }
    if (change.createdFile) {
      await unlink(change.configPath);
      return;
    }
    if (
      change.backupPath === undefined ||
      change.backupSha256 === undefined ||
      change.beforeSha256 === undefined
    ) {
      return rollbackConflict("Host config rollback metadata is incomplete");
    }
    const backup = await readSnapshot(change.backupPath);
    if (
      !backup.exists ||
      backup.bytes === undefined ||
      backup.sha256 !== change.backupSha256 ||
      backup.sha256 !== change.beforeSha256
    ) {
      return rollbackConflict("Host config backup is missing or has changed");
    }
    await atomicReplace(
      change.configPath,
      backup.bytes,
      current.mode ?? 0o600,
      current,
    );
    await rm(change.backupPath, { force: true });
  } catch (error) {
    if (error instanceof InstallerError) {
      if (
        error.code === "HOST_CONFIG_CONFLICT" ||
        error.code === "HOST_CONFIG_INVALID"
      ) {
        return rollbackConflict(
          "Host config changed during rollback; refusing to overwrite it",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "HOST_CONFIG_WRITE_FAILED",
      "Host config rollback failed",
    );
  }
}

export async function inspectHostConfigRollback(
  change: AppliedHostConfigChange,
): Promise<HostConfigRollbackStatus> {
  if (!change.changed) {
    return "unowned";
  }
  try {
    if (
      !isAbsolute(change.configPath) ||
      !/^sha256:[a-f0-9]{64}$/u.test(change.installedSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(change.installedValueHash)
    ) {
      return rollbackConflict("Host config rollback evidence is invalid");
    }
    const current = await readSnapshot(change.configPath);
    if (!current.exists) {
      if (change.createdFile) {
        return "removed";
      }
      return rollbackConflict(
        "Host config was removed after installation; refusing to restore it",
      );
    }
    if (current.sha256 !== change.installedSha256) {
      return rollbackConflict(
        "Host config changed after installation; refusing to roll it back",
      );
    }
    if (!change.createdFile) {
      if (
        change.backupPath === undefined ||
        change.backupSha256 === undefined ||
        change.beforeSha256 === undefined ||
        !isAbsolute(change.backupPath)
      ) {
        return rollbackConflict("Host config rollback metadata is incomplete");
      }
      const backup = await readSnapshot(change.backupPath);
      if (
        !backup.exists ||
        backup.sha256 !== change.backupSha256 ||
        backup.sha256 !== change.beforeSha256
      ) {
        return rollbackConflict("Host config backup is missing or has changed");
      }
    }
    return "installed";
  } catch (error) {
    if (error instanceof InstallerError) {
      if (
        error.code === "HOST_CONFIG_CONFLICT" ||
        error.code === "HOST_CONFIG_INVALID"
      ) {
        return rollbackConflict(
          "Host config is invalid during rollback inspection",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "HOST_CONFIG_WRITE_FAILED",
      "Host config rollback inspection failed",
    );
  }
}

export async function verifyHostConfigChange(
  change: AppliedHostConfigChange,
): Promise<void> {
  try {
    if (
      !isAbsolute(change.configPath) ||
      change.entryKey !== "huaweicloud-agent" ||
      !/^sha256:[a-f0-9]{64}$/u.test(change.installedSha256) ||
      !/^sha256:[a-f0-9]{64}$/u.test(change.installedValueHash)
    ) {
      return invalid("Host config verification evidence is invalid");
    }
    const current = await readSnapshot(change.configPath);
    if (!current.exists || current.sha256 !== change.installedSha256) {
      return conflict("Host config changed before installation verification");
    }
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "HOST_CONFIG_WRITE_FAILED",
      "Host config verification failed",
    );
  }
}
