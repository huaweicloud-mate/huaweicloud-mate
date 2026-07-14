import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { InstallerError } from "./errors.js";
import {
  installManifestFileName,
  isSafePluginVersion,
  stableLauncherArtifactPath,
  verifyInstallDirectory,
} from "./install-manifest.js";
import { defaultRuntimeRoot } from "./paths.js";

const stableLauncherFileName = "hcloud-agent.mjs";
const activeRuntimeFileName = "active-runtime.json";
const activeRuntimeSchemaVersion = "huaweicloud-mate-active-runtime/v1";
const maxActiveRuntimeBytes = 65_536;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface MaterializeRuntimeOptions {
  readonly sourceDirectory?: string;
  readonly runtimeRoot?: string;
}

export interface MaterializedRuntime {
  readonly pluginVersion: string;
  readonly installManifestSha256: string;
  readonly runtimeRoot: string;
  readonly versionDirectory: string;
  readonly stableLauncherPath: string;
  readonly activeRuntimePath: string;
  readonly nodePath: string;
  readonly reusedVersion: boolean;
}

export interface ActiveRuntimeSnapshot {
  readonly path: string;
  readonly pluginVersion: string;
  readonly installManifestSha256: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface AppliedActiveRuntimeChange {
  readonly activeRuntimePath: string;
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly beforeSha256?: string;
  readonly beforeBytes?: Uint8Array;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\n") ===
    [...expected].sort().join("\n");
}

function activeConflict(message: string): never {
  throw new InstallerError("RUNTIME_VERSION_CONFLICT", message);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isContained(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent !== "" &&
    !fromParent.startsWith("..") &&
    !isAbsolute(fromParent)
  );
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Runtime installation path must be a regular directory",
    );
  }
  await chmod(path, 0o700);
}

async function atomicWriteFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${randomBytes(16).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > maxActiveRuntimeBytes
    ) {
      return activeConflict("Active runtime pointer is not a regular file");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength !== entry.size) {
      return activeConflict("Active runtime pointer changed while being read");
    }
    return { exists: true, bytes, sha256: digest(bytes) };
  } catch (error) {
    if (isMissing(error)) {
      return { exists: false };
    }
    throw error;
  }
}

function parseActiveRuntime(bytes: Uint8Array): {
  readonly pluginVersion: string;
  readonly installManifestSha256: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return activeConflict("Active runtime pointer is not valid UTF-8 JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "pluginVersion",
      "installManifestSha256",
    ])
  ) {
    return activeConflict("Active runtime pointer shape is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== activeRuntimeSchemaVersion ||
    typeof record.pluginVersion !== "string" ||
    !isSafePluginVersion(record.pluginVersion) ||
    typeof record.installManifestSha256 !== "string" ||
    !digestPattern.test(record.installManifestSha256)
  ) {
    return activeConflict("Active runtime pointer binding is invalid");
  }
  return {
    pluginVersion: record.pluginVersion,
    installManifestSha256: record.installManifestSha256,
  };
}

function renderActiveRuntime(runtime: MaterializedRuntime): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: activeRuntimeSchemaVersion,
        pluginVersion: runtime.pluginVersion,
        installManifestSha256: runtime.installManifestSha256,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function snapshotMatches(
  snapshot: FileSnapshot,
  expectedSha256: string | null,
): boolean {
  return expectedSha256 === null
    ? !snapshot.exists
    : snapshot.exists && snapshot.sha256 === expectedSha256;
}

async function commitActiveRuntime(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string | null,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `.${activeRuntimeFileName}.${randomBytes(16).toString("hex")}.tmp`,
  );
  await writeExclusive(temporaryPath, bytes, 0o600);
  try {
    const current = await readSnapshot(path);
    if (!snapshotMatches(current, expectedSha256)) {
      return activeConflict("Active runtime pointer changed during activation");
    }
    if (expectedSha256 === null) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isAlreadyPresent(error)) {
          return activeConflict("Active runtime pointer appeared during activation");
        }
        throw error;
      }
      return;
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
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

async function writeExclusive(
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

async function installStableLauncher(
  sourceDirectory: string,
  currentDirectory: string,
): Promise<string> {
  const sourcePath = resolve(
    sourceDirectory,
    ...stableLauncherArtifactPath.split("/"),
  );
  const launcherPath = resolve(currentDirectory, stableLauncherFileName);
  const sourceBytes = await readFile(sourcePath);
  if (await exists(launcherPath)) {
    const entry = await lstat(launcherPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new InstallerError(
        "RUNTIME_ACTIVATION_FAILED",
        "Stable launcher path is not a regular file",
      );
    }
    const currentBytes = await readFile(launcherPath);
    if (currentBytes.equals(sourceBytes)) {
      return launcherPath;
    }
    throw new InstallerError(
      "RUNTIME_VERSION_CONFLICT",
      "Stable launcher changes require an explicit installer migration",
    );
  }
  await atomicWriteFile(launcherPath, sourceBytes, 0o700);
  return launcherPath;
}

async function removeStagingDirectory(
  versionsDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  if (
    !isContained(versionsDirectory, stagingDirectory) ||
    !stagingDirectory.endsWith(".tmp")
  ) {
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Refusing to remove an unexpected runtime path",
    );
  }
  await rm(stagingDirectory, { recursive: true, force: true });
}

async function copyVerifiedRuntime(
  sourceDirectory: string,
  targetDirectory: string,
  artifacts: readonly { readonly path: string }[],
): Promise<void> {
  await ensureDirectory(targetDirectory);
  for (const artifact of artifacts) {
    const segments = artifact.path.split("/");
    const sourcePath = resolve(sourceDirectory, ...segments);
    const targetPath = resolve(targetDirectory, ...segments);
    await ensureDirectory(dirname(targetPath));
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o600);
  }
  await copyFile(
    resolve(sourceDirectory, installManifestFileName),
    resolve(targetDirectory, installManifestFileName),
  );
  await chmod(resolve(targetDirectory, installManifestFileName), 0o600);
}

export async function materializeRuntimeCandidate(
  options: MaterializeRuntimeOptions = {},
): Promise<MaterializedRuntime> {
  const sourceDirectory = resolve(
    options.sourceDirectory ??
      dirname(fileURLToPath(new URL("../install-manifest.json", import.meta.url))),
  );
  const runtimeRoot = resolve(options.runtimeRoot ?? defaultRuntimeRoot());
  if (
    isContained(sourceDirectory, runtimeRoot) ||
    isContained(runtimeRoot, sourceDirectory) ||
    sourceDirectory === runtimeRoot
  ) {
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Runtime source and installation roots must be separate",
    );
  }

  let source;
  try {
    source = await verifyInstallDirectory(sourceDirectory);
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "RUNTIME_ARTIFACT_INVALID",
      "Runtime source could not be verified",
    );
  }

  const versionsDirectory = resolve(runtimeRoot, "versions");
  const currentDirectory = resolve(runtimeRoot, "current");
  const versionDirectory = resolve(
    versionsDirectory,
    source.manifest.pluginVersion,
  );
  if (!isContained(versionsDirectory, versionDirectory)) {
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Runtime version path escapes the versions directory",
    );
  }
  await ensureDirectory(runtimeRoot);
  await ensureDirectory(versionsDirectory);
  await ensureDirectory(currentDirectory);

  let reusedVersion = false;
  if (await exists(versionDirectory)) {
    try {
      await verifyInstallDirectory(versionDirectory, source.manifestSha256);
      reusedVersion = true;
    } catch {
      throw new InstallerError(
        "RUNTIME_VERSION_CONFLICT",
        "The installed runtime version differs from the verified package",
      );
    }
  } else {
    const stagingDirectory = resolve(
      versionsDirectory,
      `.${source.manifest.pluginVersion}.${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      await copyVerifiedRuntime(
        sourceDirectory,
        stagingDirectory,
        source.manifest.artifacts,
      );
      await verifyInstallDirectory(stagingDirectory, source.manifestSha256);
      await rename(stagingDirectory, versionDirectory);
    } catch (error) {
      await removeStagingDirectory(versionsDirectory, stagingDirectory);
      if (error instanceof InstallerError) {
        throw error;
      }
      throw new InstallerError(
        "RUNTIME_ACTIVATION_FAILED",
        "Verified runtime could not be materialized",
      );
    }
  }

  let stableLauncherPath: string;
  try {
    stableLauncherPath = await installStableLauncher(
      sourceDirectory,
      currentDirectory,
    );
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Stable launcher could not be installed",
    );
  }
  return {
    pluginVersion: source.manifest.pluginVersion,
    installManifestSha256: source.manifestSha256,
    runtimeRoot,
    versionDirectory,
    stableLauncherPath,
    activeRuntimePath: resolve(currentDirectory, activeRuntimeFileName),
    nodePath: process.execPath,
    reusedVersion,
  };
}

export async function readActiveRuntimeSnapshot(
  runtimeRoot: string,
): Promise<ActiveRuntimeSnapshot | undefined> {
  if (!isAbsolute(runtimeRoot)) {
    return activeConflict("Active runtime root must be absolute");
  }
  const path = resolve(runtimeRoot, "current", activeRuntimeFileName);
  const snapshot = await readSnapshot(path);
  if (
    !snapshot.exists ||
    snapshot.bytes === undefined ||
    snapshot.sha256 === undefined
  ) {
    return undefined;
  }
  const parsed = parseActiveRuntime(snapshot.bytes);
  return {
    path,
    pluginVersion: parsed.pluginVersion,
    installManifestSha256: parsed.installManifestSha256,
    sha256: snapshot.sha256,
    bytes: Buffer.from(snapshot.bytes),
  };
}

function validateRuntimeBinding(runtime: MaterializedRuntime): void {
  const runtimeRoot = resolve(runtime.runtimeRoot);
  if (
    !isAbsolute(runtime.runtimeRoot) ||
    !isAbsolute(runtime.versionDirectory) ||
    !isAbsolute(runtime.stableLauncherPath) ||
    !isAbsolute(runtime.activeRuntimePath) ||
    !isSafePluginVersion(runtime.pluginVersion) ||
    !digestPattern.test(runtime.installManifestSha256) ||
    resolve(runtime.versionDirectory) !==
      resolve(runtimeRoot, "versions", runtime.pluginVersion) ||
    resolve(runtime.stableLauncherPath) !==
      resolve(runtimeRoot, "current", stableLauncherFileName) ||
    resolve(runtime.activeRuntimePath) !==
      resolve(runtimeRoot, "current", activeRuntimeFileName)
  ) {
    return activeConflict("Materialized runtime binding is invalid");
  }
}

export async function activateMaterializedRuntime(
  runtime: MaterializedRuntime,
  expectedSha256?: string | null,
): Promise<AppliedActiveRuntimeChange> {
  try {
    validateRuntimeBinding(runtime);
    const verified = await verifyInstallDirectory(
      runtime.versionDirectory,
      runtime.installManifestSha256,
    );
    if (verified.manifest.pluginVersion !== runtime.pluginVersion) {
      return activeConflict("Candidate runtime version binding is invalid");
    }
    const before = await readSnapshot(runtime.activeRuntimePath);
    if (
      expectedSha256 !== undefined &&
      !snapshotMatches(before, expectedSha256)
    ) {
      return activeConflict("Active runtime no longer matches the expected version");
    }
    if (before.bytes !== undefined) {
      parseActiveRuntime(before.bytes);
    }
    const bytes = renderActiveRuntime(runtime);
    const installedSha256 = digest(bytes);
    if (before.sha256 === installedSha256) {
      return {
        activeRuntimePath: runtime.activeRuntimePath,
        changed: false,
        createdFile: false,
        installedSha256,
      };
    }
    await commitActiveRuntime(
      runtime.activeRuntimePath,
      bytes,
      before.sha256 ?? null,
    );
    return {
      activeRuntimePath: runtime.activeRuntimePath,
      changed: true,
      createdFile: !before.exists,
      installedSha256,
      ...(before.sha256 === undefined
        ? {}
        : { beforeSha256: before.sha256 }),
      ...(before.bytes === undefined
        ? {}
        : { beforeBytes: Buffer.from(before.bytes) }),
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Verified runtime could not be activated",
    );
  }
}

export async function rollbackActiveRuntimeChange(
  change: AppliedActiveRuntimeChange,
): Promise<void> {
  if (!change.changed) {
    return;
  }
  let quarantinePath: string | undefined;
  try {
    if (
      !isAbsolute(change.activeRuntimePath) ||
      basename(change.activeRuntimePath) !== activeRuntimeFileName ||
      !digestPattern.test(change.installedSha256)
    ) {
      return activeConflict("Active runtime rollback evidence is invalid");
    }
    const current = await readSnapshot(change.activeRuntimePath);
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
      return activeConflict(
        "Active runtime changed after activation; refusing to roll it back",
      );
    }
    if (change.createdFile) {
      quarantinePath = resolve(
        dirname(change.activeRuntimePath),
        `.${activeRuntimeFileName}.${randomBytes(16).toString("hex")}.rollback`,
      );
      await rename(change.activeRuntimePath, quarantinePath);
      const captured = await readSnapshot(quarantinePath);
      if (captured.sha256 !== change.installedSha256) {
        if (await restoreQuarantine(quarantinePath, change.activeRuntimePath)) {
          quarantinePath = undefined;
        }
        return activeConflict(
          "Active runtime changed during rollback; refusing to remove it",
        );
      }
      await rm(quarantinePath, { force: true });
      quarantinePath = undefined;
      return;
    }
    if (
      change.beforeBytes === undefined ||
      change.beforeSha256 === undefined ||
      digest(change.beforeBytes) !== change.beforeSha256
    ) {
      return activeConflict("Active runtime rollback evidence is incomplete");
    }
    parseActiveRuntime(change.beforeBytes);
    await commitActiveRuntime(
      change.activeRuntimePath,
      change.beforeBytes,
      change.installedSha256,
    );
  } catch (error) {
    if (quarantinePath !== undefined) {
      if (await restoreQuarantine(quarantinePath, change.activeRuntimePath)) {
        quarantinePath = undefined;
      }
    }
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Active runtime rollback failed",
    );
  }
}

export async function materializeStableRuntime(
  options: MaterializeRuntimeOptions = {},
): Promise<MaterializedRuntime> {
  const runtime = await materializeRuntimeCandidate(options);
  await activateMaterializedRuntime(runtime);
  return runtime;
}
