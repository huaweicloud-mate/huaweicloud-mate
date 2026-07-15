import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { InstallerError } from "./errors.js";
import { isSafePluginVersion } from "./install-manifest.js";

export const codexUpgradeRecoveryFileName = "codex-upgrade-recovery.json";
export const claudeUpgradeRecoveryFileName = "claude-upgrade-recovery.json";
export const configHostUpgradeRecoveryFileName = "config-host-upgrade-recovery.json";
export const multiHostUpgradeRecoveryFileName = "multi-host-upgrade-recovery.json";

const maxRecoveryBytes = 16 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const boundedTextPattern = /^.{1,256}$/u;

export interface CodexUpgradeActivationEvidence {
  readonly pluginId: string;
  readonly version: string;
  readonly installedEntryHash: string;
}

export interface CodexUpgradeRecovery {
  readonly schemaVersion: 1;
  readonly host: "codex";
  readonly oldStateSha256: string;
  readonly oldPluginVersion: string;
  readonly oldInstallManifestSha256: string;
  readonly oldActiveRuntimeSha256: string;
  readonly candidatePluginVersion: string;
  readonly candidateInstallManifestSha256: string;
  readonly candidateAssetTreeHash: string;
  readonly candidateActivation?: CodexUpgradeActivationEvidence;
  readonly candidateActiveRuntimeSha256?: string;
}

export interface CodexUpgradeRecoverySnapshot {
  readonly recovery: CodexUpgradeRecovery;
  readonly sha256: string;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
}

function invalid(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_CONFLICT", message);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function parseActivation(value: unknown): CodexUpgradeActivationEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["pluginId", "version", "installedEntryHash"]) ||
    typeof value.pluginId !== "string" ||
    !boundedTextPattern.test(value.pluginId) ||
    typeof value.version !== "string" ||
    !boundedTextPattern.test(value.version) ||
    !isDigest(value.installedEntryHash)
  ) {
    return invalid("Codex upgrade recovery activation evidence is invalid");
  }
  return {
    pluginId: value.pluginId,
    version: value.version,
    installedEntryHash: value.installedEntryHash,
  };
}

export function parseCodexUpgradeRecovery(value: unknown): CodexUpgradeRecovery {
  if (!isRecord(value)) {
    return invalid("Codex upgrade recovery marker must be a JSON object");
  }
  const expectedKeys = [
    "schemaVersion",
    "host",
    "oldStateSha256",
    "oldPluginVersion",
    "oldInstallManifestSha256",
    "oldActiveRuntimeSha256",
    "candidatePluginVersion",
    "candidateInstallManifestSha256",
    "candidateAssetTreeHash",
    ...(value.candidateActivation === undefined ? [] : ["candidateActivation"]),
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? []
      : ["candidateActiveRuntimeSha256"]),
  ];
  if (
    !exactKeys(value, expectedKeys) ||
    value.schemaVersion !== 1 ||
    value.host !== "codex" ||
    !isDigest(value.oldStateSha256) ||
    typeof value.oldPluginVersion !== "string" ||
    !isSafePluginVersion(value.oldPluginVersion) ||
    !isDigest(value.oldInstallManifestSha256) ||
    !isDigest(value.oldActiveRuntimeSha256) ||
    typeof value.candidatePluginVersion !== "string" ||
    !isSafePluginVersion(value.candidatePluginVersion) ||
    !isDigest(value.candidateInstallManifestSha256) ||
    !isDigest(value.candidateAssetTreeHash) ||
    (value.oldPluginVersion === value.candidatePluginVersion &&
      value.oldInstallManifestSha256 === value.candidateInstallManifestSha256)
  ) {
    return invalid("Codex upgrade recovery marker is invalid");
  }
  if (
    value.candidateActiveRuntimeSha256 !== undefined &&
    (!isDigest(value.candidateActiveRuntimeSha256) ||
      value.candidateActivation === undefined)
  ) {
    return invalid("Codex upgrade recovery pointer evidence is invalid");
  }
  return {
    schemaVersion: 1,
    host: "codex",
    oldStateSha256: value.oldStateSha256,
    oldPluginVersion: value.oldPluginVersion,
    oldInstallManifestSha256: value.oldInstallManifestSha256,
    oldActiveRuntimeSha256: value.oldActiveRuntimeSha256,
    candidatePluginVersion: value.candidatePluginVersion,
    candidateInstallManifestSha256: value.candidateInstallManifestSha256,
    candidateAssetTreeHash: value.candidateAssetTreeHash,
    ...(value.candidateActivation === undefined
      ? {}
      : { candidateActivation: parseActivation(value.candidateActivation) }),
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? {}
      : { candidateActiveRuntimeSha256: value.candidateActiveRuntimeSha256 }),
  };
}

export function codexUpgradeRecoveryPath(runtimeRoot: string): string {
  if (!isAbsolute(runtimeRoot)) {
    return invalid("Codex upgrade recovery runtime root must be absolute");
  }
  return resolve(runtimeRoot, codexUpgradeRecoveryFileName);
}

async function assertRuntimeRoot(runtimeRoot: string): Promise<string> {
  if (!isAbsolute(runtimeRoot)) {
    return invalid("Codex upgrade recovery runtime root must be absolute");
  }
  const root = resolve(runtimeRoot);
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return invalid("Codex upgrade recovery runtime root is not a regular directory");
  }
  return root;
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
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxRecoveryBytes) {
    return invalid("Codex upgrade recovery marker must be a bounded regular file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size || bytes.byteLength > maxRecoveryBytes) {
    return invalid("Codex upgrade recovery marker changed while it was read");
  }
  return { exists: true, bytes, sha256: digest(bytes) };
}

function decode(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Codex upgrade recovery marker is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid("Codex upgrade recovery marker is not valid JSON");
  }
}

export async function readCodexUpgradeRecovery(
  runtimeRoot: string,
): Promise<CodexUpgradeRecoverySnapshot | undefined> {
  try {
    const root = await assertRuntimeRoot(runtimeRoot);
    const snapshot = await readSnapshot(codexUpgradeRecoveryPath(root));
    if (!snapshot.exists || snapshot.bytes === undefined || snapshot.sha256 === undefined) {
      return undefined;
    }
    return {
      recovery: parseCodexUpgradeRecovery(decode(snapshot.bytes)),
      sha256: snapshot.sha256,
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UPGRADE_RECOVERY_INVALID",
      "Codex upgrade recovery marker could not be read",
    );
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

function snapshotMatches(snapshot: FileSnapshot, expectedSha256: string | null): boolean {
  return expectedSha256 === null
    ? !snapshot.exists
    : snapshot.exists && snapshot.sha256 === expectedSha256;
}

async function commitBytes(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let committed = false;
  try {
    await writeExclusive(temporaryPath, bytes);
    const current = await readSnapshot(path);
    if (!snapshotMatches(current, expectedSha256)) {
      return conflict("Codex upgrade recovery marker changed during the transaction");
    }
    if (expectedSha256 === null) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isAlreadyPresent(error)) {
          return conflict("Codex upgrade recovery marker appeared during the transaction");
        }
        throw error;
      }
      committed = true;
      return;
    }
    await rename(temporaryPath, path);
    committed = true;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      if (!committed) {
        throw error;
      }
    }
  }
}

export async function replaceCodexUpgradeRecovery(
  runtimeRoot: string,
  recovery: CodexUpgradeRecovery,
  expectedSha256: string | null,
): Promise<CodexUpgradeRecoverySnapshot> {
  try {
    if (expectedSha256 !== null && !digestPattern.test(expectedSha256)) {
      return invalid("Expected Codex upgrade recovery digest is invalid");
    }
    const root = await assertRuntimeRoot(runtimeRoot);
    const normalized = parseCodexUpgradeRecovery(recovery);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    if (bytes.byteLength > maxRecoveryBytes) {
      return invalid("Rendered Codex upgrade recovery marker exceeds the size limit");
    }
    const path = codexUpgradeRecoveryPath(root);
    const before = await readSnapshot(path);
    if (!snapshotMatches(before, expectedSha256)) {
      return conflict("Codex upgrade recovery marker no longer matches its digest");
    }
    const sha256 = digest(bytes);
    if (before.sha256 !== sha256) {
      await commitBytes(path, bytes, expectedSha256);
    }
    return { recovery: normalized, sha256 };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UPGRADE_RECOVERY_WRITE_FAILED",
      "Codex upgrade recovery marker transaction failed",
    );
  }
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

export async function removeCodexUpgradeRecovery(
  runtimeRoot: string,
  expectedSha256: string,
): Promise<void> {
  let quarantinePath: string | undefined;
  let path = "";
  try {
    if (!digestPattern.test(expectedSha256)) {
      return invalid("Expected Codex upgrade recovery digest is invalid");
    }
    const root = await assertRuntimeRoot(runtimeRoot);
    path = codexUpgradeRecoveryPath(root);
    const before = await readSnapshot(path);
    if (!before.exists || before.sha256 !== expectedSha256) {
      return conflict("Codex upgrade recovery marker changed before removal");
    }
    quarantinePath = resolve(
      root,
      `.${codexUpgradeRecoveryFileName}.${randomBytes(16).toString("hex")}.rollback`,
    );
    await rename(path, quarantinePath);
    const captured = await readSnapshot(quarantinePath);
    if (captured.sha256 !== expectedSha256) {
      if (await restoreQuarantine(quarantinePath, path)) {
        quarantinePath = undefined;
      }
      return conflict("Codex upgrade recovery marker changed during removal");
    }
    await rm(quarantinePath, { force: true });
    quarantinePath = undefined;
  } catch (error) {
    if (quarantinePath !== undefined && path !== "") {
      if (await restoreQuarantine(quarantinePath, path)) {
        quarantinePath = undefined;
      }
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "UPGRADE_RECOVERY_WRITE_FAILED",
      "Codex upgrade recovery marker could not be removed",
    );
  }
}

export interface UpgradeRecoveryDocumentSnapshot {
  readonly value: unknown;
  readonly sha256: string;
}

function recoveryDocumentPath(runtimeRoot: string, fileName: string): string {
  if (
    fileName !== codexUpgradeRecoveryFileName &&
    fileName !== claudeUpgradeRecoveryFileName &&
    fileName !== configHostUpgradeRecoveryFileName &&
    fileName !== multiHostUpgradeRecoveryFileName
  ) {
    return invalid("Upgrade recovery marker filename is unsupported");
  }
  return resolve(runtimeRoot, fileName);
}

export async function readUpgradeRecoveryDocument(
  runtimeRoot: string,
  fileName: string,
): Promise<UpgradeRecoveryDocumentSnapshot | undefined> {
  try {
    const root = await assertRuntimeRoot(runtimeRoot);
    const snapshot = await readSnapshot(recoveryDocumentPath(root, fileName));
    if (
      !snapshot.exists ||
      snapshot.bytes === undefined ||
      snapshot.sha256 === undefined
    ) {
      return undefined;
    }
    return { value: decode(snapshot.bytes), sha256: snapshot.sha256 };
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "UPGRADE_RECOVERY_INVALID",
      "Upgrade recovery marker could not be read",
    );
  }
}

export async function replaceUpgradeRecoveryDocument(
  runtimeRoot: string,
  fileName: string,
  value: unknown,
  expectedSha256: string | null,
): Promise<UpgradeRecoveryDocumentSnapshot> {
  try {
    if (expectedSha256 !== null && !digestPattern.test(expectedSha256)) {
      return invalid("Expected upgrade recovery digest is invalid");
    }
    const root = await assertRuntimeRoot(runtimeRoot);
    const path = recoveryDocumentPath(root, fileName);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (bytes.byteLength > maxRecoveryBytes) {
      return invalid("Rendered upgrade recovery marker exceeds the size limit");
    }
    const before = await readSnapshot(path);
    if (!snapshotMatches(before, expectedSha256)) {
      return conflict("Upgrade recovery marker no longer matches its digest");
    }
    const sha256 = digest(bytes);
    if (before.sha256 !== sha256) {
      await commitBytes(path, bytes, expectedSha256);
    }
    return { value, sha256 };
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "UPGRADE_RECOVERY_WRITE_FAILED",
      "Upgrade recovery marker transaction failed",
    );
  }
}

export async function removeUpgradeRecoveryDocument(
  runtimeRoot: string,
  fileName: string,
  expectedSha256: string,
): Promise<void> {
  let quarantinePath: string | undefined;
  let path = "";
  try {
    if (!digestPattern.test(expectedSha256)) {
      return invalid("Expected upgrade recovery digest is invalid");
    }
    const root = await assertRuntimeRoot(runtimeRoot);
    path = recoveryDocumentPath(root, fileName);
    const before = await readSnapshot(path);
    if (!before.exists || before.sha256 !== expectedSha256) {
      return conflict("Upgrade recovery marker changed before removal");
    }
    quarantinePath = resolve(
      root,
      `.${fileName}.${randomBytes(16).toString("hex")}.rollback`,
    );
    await rename(path, quarantinePath);
    const captured = await readSnapshot(quarantinePath);
    if (captured.sha256 !== expectedSha256) {
      if (await restoreQuarantine(quarantinePath, path)) {
        quarantinePath = undefined;
      }
      return conflict("Upgrade recovery marker changed during removal");
    }
    await rm(quarantinePath, { force: true });
    quarantinePath = undefined;
  } catch (error) {
    if (quarantinePath !== undefined && path !== "") {
      if (await restoreQuarantine(quarantinePath, path)) {
        quarantinePath = undefined;
      }
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "UPGRADE_RECOVERY_WRITE_FAILED",
      "Upgrade recovery marker could not be removed",
    );
  }
}
