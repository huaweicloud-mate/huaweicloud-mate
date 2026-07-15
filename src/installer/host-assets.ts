import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { HostInstallPlan } from "../hosts/plan.js";
import { InstallerError } from "./errors.js";
import {
  type InstallArtifact,
  verifyInstallDirectory,
} from "./install-manifest.js";

const maxAssetCount = 4096;
const maxAssetFileBytes = 64 * 1024 * 1024;
const maxAssetTreeBytes = 512 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface HostAssetRuntime {
  readonly pluginVersion: string;
  readonly versionDirectory: string;
  readonly installManifestSha256: string;
}

export interface AppliedHostAssetChange {
  readonly hostId: HostInstallPlan["id"];
  readonly kind: "plugin" | "skill";
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly changed: boolean;
  readonly installedTreeHash: string;
  readonly createdPaths: readonly string[];
}

export type HostAssetRollbackStatus = "installed" | "removed" | "unowned";

interface PreparedHostAsset {
  readonly paths: ReturnType<typeof assetPaths>;
  readonly stagingPath: string;
  readonly createdParents: readonly string[];
  readonly desiredTreeHash: string;
}

function invalid(message: string): never {
  throw new InstallerError("HOST_ASSET_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("HOST_ASSET_CONFLICT", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("HOST_ASSET_ROLLBACK_CONFLICT", message);
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
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    !fromRoot.startsWith("..") &&
    !isAbsolute(fromRoot)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    samePath(left, right) ||
    isContained(left, right) ||
    isContained(right, left)
  );
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

async function overwriteStagedFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return invalid("Staged host asset is not a regular file");
  }
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function ensureParentDirectories(targetPath: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dirname(targetPath);
  while (true) {
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return invalid("Host asset parent is not a regular directory");
      }
      break;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) {
        return invalid("Host asset path has no existing directory ancestor");
      }
      current = parent;
    }
  }

  const created: string[] = [];
  for (const path of missing.reverse()) {
    try {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
      created.push(path);
    } catch (error) {
      if (!isAlreadyPresent(error)) {
        throw error;
      }
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        return invalid("Host asset parent changed during creation");
      }
    }
  }
  return created;
}

async function cleanupEmptyDirectories(paths: readonly string[]): Promise<void> {
  for (const path of [...paths].reverse()) {
    try {
      await rmdir(path);
    } catch {
      // Preserve non-empty or externally changed directories.
    }
  }
}

function artifactSubset(
  artifacts: readonly InstallArtifact[],
  prefix: string,
): readonly InstallArtifact[] {
  const withSlash = `${prefix}/`;
  const selected = artifacts.filter((artifact) =>
    artifact.path.startsWith(withSlash),
  );
  if (selected.length === 0) {
    return invalid("Verified runtime does not contain the host asset source");
  }
  return selected;
}

async function copyVerifiedArtifacts(
  versionDirectory: string,
  prefix: string,
  artifacts: readonly InstallArtifact[],
  stagingPath: string,
): Promise<void> {
  for (const artifact of artifactSubset(artifacts, prefix)) {
    const relativePath = artifact.path.slice(prefix.length + 1);
    if (relativePath.length === 0) {
      return invalid("Host asset artifact path is incomplete");
    }
    const sourcePath = resolve(
      versionDirectory,
      ...artifact.path.split("/"),
    );
    const targetPath = resolve(stagingPath, ...relativePath.split("/"));
    if (!isContained(stagingPath, targetPath)) {
      return invalid("Host asset artifact escapes the staging directory");
    }
    const sourceEntry = await lstat(sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
      return invalid("Host asset source is not a regular file");
    }
    const bytes = await readFile(sourcePath);
    if (
      bytes.byteLength !== artifact.size ||
      digest(bytes) !== artifact.sha256
    ) {
      return invalid("Host asset changed after runtime verification");
    }
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeExclusive(targetPath, bytes, 0o600);
  }
}

function parseJsonObject(bytes: Uint8Array, description: string): Record<string, unknown> {
  if (bytes.byteLength > maxAssetFileBytes) {
    return invalid(`${description} exceeds the size limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid(`${description} is not valid UTF-8 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${description} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function validatePluginPlaceholder(value: Record<string, unknown>): void {
  const expected = {
    mcpServers: {
      "huaweicloud-agent": {
        command: "{nodePath}",
        args: ["{stableLauncherPath}", "router", "--stdio"],
      },
    },
  };
  if (!isDeepStrictEqual(value, expected)) {
    return invalid("Plugin MCP source does not contain the fixed placeholders");
  }
}

function renderPluginMcp(plan: HostInstallPlan): Buffer {
  let value: unknown;
  try {
    value = JSON.parse(JSON.stringify(plan.configFragment)) as unknown;
  } catch {
    return invalid("Plugin MCP fragment is not valid JSON data");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ["mcpServers"])
  ) {
    return invalid("Plugin MCP fragment has an unexpected root");
  }
  const root = (value as Record<string, unknown>).mcpServers;
  if (
    typeof root !== "object" ||
    root === null ||
    Array.isArray(root) ||
    !exactKeys(root as Record<string, unknown>, [plan.entryKey])
  ) {
    return invalid("Plugin MCP fragment has an unexpected entry");
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function validateStagedPlugin(
  plan: HostInstallPlan,
  runtime: HostAssetRuntime,
  stagingPath: string,
): Promise<void> {
  const manifestRelativePath = plan.id === "codex"
    ? ".codex-plugin/plugin.json"
    : ".claude-plugin/plugin.json";
  const manifest = parseJsonObject(
    await readFile(resolve(stagingPath, ...manifestRelativePath.split("/"))),
    "Plugin manifest",
  );
  if (
    manifest.name !== "huaweicloud-mate" ||
    manifest.version !== runtime.pluginVersion ||
    manifest.skills !== "./skills/" ||
    manifest.mcpServers !== "./.mcp.json"
  ) {
    return invalid("Plugin manifest identity or component paths are invalid");
  }
  const mcp = parseJsonObject(
    await readFile(resolve(stagingPath, ".mcp.json")),
    "Rendered plugin MCP config",
  );
  if (!isDeepStrictEqual(mcp, JSON.parse(JSON.stringify(plan.configFragment)))) {
    return invalid("Rendered plugin MCP config does not match the install plan");
  }
  const skill = await readFile(
    resolve(stagingPath, "skills", "huaweicloud", "SKILL.md"),
    "utf8",
  );
  if (
    !skill.startsWith("---\nname: huaweicloud\n") ||
    skill.includes("[TODO:")
  ) {
    return invalid("Plugin canonical Skill is invalid");
  }
}

async function validateStagedSkill(stagingPath: string): Promise<void> {
  const skill = await readFile(resolve(stagingPath, "SKILL.md"), "utf8");
  if (
    !skill.startsWith("---\nname: huaweicloud\n") ||
    skill.includes("[TODO:")
  ) {
    return invalid("Canonical Skill is invalid");
  }
}

async function treeHash(root: string): Promise<string> {
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    return invalid("Host asset target is not a regular directory");
  }
  const records: string[] = [];
  let count = 0;
  let totalBytes = 0;

  async function walk(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      count += 1;
      if (count > maxAssetCount) {
        return invalid("Host asset tree contains too many entries");
      }
      const path = resolve(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        return invalid("Host asset tree cannot contain symbolic links");
      }
      if (entry.isDirectory()) {
        records.push(`D:${relativePath}`);
        await walk(path, relativePath);
        continue;
      }
      if (!entry.isFile() || entry.size > maxAssetFileBytes) {
        return invalid("Host asset tree contains an invalid file");
      }
      const bytes = await readFile(path);
      if (bytes.byteLength !== entry.size) {
        return invalid("Host asset file changed while it was being read");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > maxAssetTreeBytes) {
        return invalid("Host asset tree exceeds the size limit");
      }
      records.push(
        `F:${relativePath}:${bytes.byteLength}:${digest(bytes)}`,
      );
    }
  }

  await walk(root, "");
  return digest(Buffer.from(records.join("\n"), "utf8"));
}

async function existingTreeHash(path: string): Promise<string | undefined> {
  try {
    return await treeHash(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function inspectHostAssetTreeHash(
  path: string,
): Promise<string | undefined> {
  try {
    if (!isAbsolute(path)) {
      return invalid("Host asset inspection target is not absolute");
    }
    return await existingTreeHash(resolve(path));
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset inspection failed",
    );
  }
}

function assetPaths(plan: HostInstallPlan, runtime: HostAssetRuntime): {
  readonly kind: "plugin" | "skill";
  readonly prefix: string;
  readonly sourcePath: string;
  readonly targetPath: string;
} {
  const versionDirectory = resolve(runtime.versionDirectory);
  const isPlugin = plan.mergeStrategy === "plugin-manifest";
  if (isPlugin) {
    if (
      plan.pluginSourcePath === undefined ||
      plan.pluginTargetPath === undefined
    ) {
      return invalid("Plugin install plan is missing its source or target");
    }
    const expectedSource = resolve(
      versionDirectory,
      "host-assets",
      plan.id,
      "plugin",
    );
    const sourcePath = resolve(plan.pluginSourcePath);
    const targetPath = resolve(plan.pluginTargetPath);
    if (
      !samePath(sourcePath, expectedSource) ||
      !samePath(plan.skillSourcePath, resolve(sourcePath, "skills", "huaweicloud")) ||
      !samePath(plan.skillTargetPath, resolve(targetPath, "skills", "huaweicloud")) ||
      !samePath(plan.configPath, resolve(targetPath, ".mcp.json"))
    ) {
      return invalid("Plugin install plan paths do not match the fixed layout");
    }
    return {
      kind: "plugin",
      prefix: `host-assets/${plan.id}/plugin`,
      sourcePath,
      targetPath,
    };
  }
  if (
    plan.pluginSourcePath !== undefined ||
    plan.pluginTargetPath !== undefined
  ) {
    return invalid("Non-plugin install plan contains plugin paths");
  }
  const expectedSource = resolve(
    versionDirectory,
    "skills",
    "canonical",
    "huaweicloud",
  );
  const sourcePath = resolve(plan.skillSourcePath);
  if (!samePath(sourcePath, expectedSource)) {
    return invalid("Canonical Skill source does not match the fixed layout");
  }
  return {
    kind: "skill",
    prefix: "skills/canonical/huaweicloud",
    sourcePath,
    targetPath: resolve(plan.skillTargetPath),
  };
}

async function prepareHostAsset(
  plan: HostInstallPlan,
  runtime: HostAssetRuntime,
): Promise<PreparedHostAsset> {
  let stagingPath: string | undefined;
  let createdParents: string[] = [];
  try {
    if (
      !isAbsolute(runtime.versionDirectory) ||
      !digestPattern.test(runtime.installManifestSha256)
    ) {
      return invalid("Host asset runtime binding is invalid");
    }
    const verified = await verifyInstallDirectory(
      runtime.versionDirectory,
      runtime.installManifestSha256,
    );
    if (verified.manifest.pluginVersion !== runtime.pluginVersion) {
      return invalid("Host asset runtime version does not match its manifest");
    }
    const paths = assetPaths(plan, runtime);
    if (
      !isAbsolute(paths.targetPath) ||
      pathsOverlap(paths.sourcePath, paths.targetPath)
    ) {
      return invalid("Host asset source and target paths are unsafe");
    }
    const sourceEntry = await lstat(paths.sourcePath);
    if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) {
      return invalid("Host asset source is not a regular directory");
    }

    createdParents = await ensureParentDirectories(paths.targetPath);
    const targetParent = dirname(paths.targetPath);
    stagingPath = resolve(
      targetParent,
      `.${basename(paths.targetPath)}.${randomBytes(16).toString("hex")}.tmp`,
    );
    await mkdir(stagingPath, { mode: 0o700 });
    await chmod(stagingPath, 0o700);
    await copyVerifiedArtifacts(
      runtime.versionDirectory,
      paths.prefix,
      verified.manifest.artifacts,
      stagingPath,
    );

    if (paths.kind === "plugin") {
      const stagedMcpPath = resolve(stagingPath, ".mcp.json");
      validatePluginPlaceholder(
        parseJsonObject(await readFile(stagedMcpPath), "Plugin MCP source"),
      );
      await overwriteStagedFile(stagedMcpPath, renderPluginMcp(plan));
      await validateStagedPlugin(plan, runtime, stagingPath);
    } else {
      await validateStagedSkill(stagingPath);
    }

    return {
      paths,
      stagingPath,
      createdParents,
      desiredTreeHash: await treeHash(stagingPath),
    };
  } catch (error) {
    if (stagingPath !== undefined) {
      await rm(stagingPath, { recursive: true, force: true });
    }
    await cleanupEmptyDirectories(createdParents);
    throw error;
  }
}

export async function expectedHostAssetTreeHash(
  plan: HostInstallPlan,
  runtime: HostAssetRuntime,
): Promise<string> {
  let prepared: PreparedHostAsset | undefined;
  try {
    prepared = await prepareHostAsset(plan, runtime);
    return prepared.desiredTreeHash;
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset evidence could not be prepared",
    );
  } finally {
    if (prepared !== undefined) {
      await rm(prepared.stagingPath, { recursive: true, force: true });
      await cleanupEmptyDirectories(prepared.createdParents);
    }
  }
}

export async function materializeHostAssets(
  plan: HostInstallPlan,
  runtime: HostAssetRuntime,
): Promise<AppliedHostAssetChange> {
  let stagingPath: string | undefined;
  let createdParents: string[] = [];
  try {
    const prepared = await prepareHostAsset(plan, runtime);
    const { paths, desiredTreeHash } = prepared;
    stagingPath = prepared.stagingPath;
    createdParents = [...prepared.createdParents];
    const currentTreeHash = await existingTreeHash(paths.targetPath);
    if (currentTreeHash !== undefined) {
      await rm(stagingPath, { recursive: true, force: true });
      stagingPath = undefined;
      if (currentTreeHash !== desiredTreeHash) {
        return conflict("Host asset target already contains different content");
      }
      return {
        hostId: plan.id,
        kind: paths.kind,
        sourcePath: paths.sourcePath,
        targetPath: paths.targetPath,
        changed: false,
        installedTreeHash: currentTreeHash,
        createdPaths: [],
      };
    }

    try {
      await rename(stagingPath, paths.targetPath);
    } catch (error) {
      if (
        isAlreadyPresent(error) ||
        (await existingTreeHash(paths.targetPath)) !== undefined
      ) {
        return conflict("Host asset target appeared during materialization");
      }
      throw error;
    }
    stagingPath = undefined;
    return {
      hostId: plan.id,
      kind: paths.kind,
      sourcePath: paths.sourcePath,
      targetPath: paths.targetPath,
      changed: true,
      installedTreeHash: desiredTreeHash,
      createdPaths: [...createdParents, paths.targetPath],
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset materialization failed",
    );
  } finally {
    if (stagingPath !== undefined) {
      await rm(stagingPath, { recursive: true, force: true });
    }
    await cleanupEmptyDirectories(createdParents);
  }
}

export async function rollbackHostAssetChange(
  change: AppliedHostAssetChange,
): Promise<void> {
  if (!change.changed) {
    return;
  }
  let quarantinePath: string | undefined;
  try {
    if (!isAbsolute(change.targetPath)) {
      return rollbackConflict("Host asset rollback target is not absolute");
    }
    const currentTreeHash = await existingTreeHash(change.targetPath);
    if (currentTreeHash === undefined) {
      await cleanupEmptyDirectories(
        change.createdPaths.filter(
          (path) =>
            isAbsolute(path) &&
            !samePath(path, change.targetPath) &&
            isContained(path, change.targetPath),
        ),
      );
      return;
    }
    if (currentTreeHash !== change.installedTreeHash) {
      return rollbackConflict(
        "Host asset changed after installation; refusing to remove it",
      );
    }
    quarantinePath = resolve(
      dirname(change.targetPath),
      `.${basename(change.targetPath)}.${randomBytes(16).toString("hex")}.rollback`,
    );
    try {
      await rename(change.targetPath, quarantinePath);
    } catch {
      return rollbackConflict(
        "Host asset changed during rollback; refusing to remove it",
      );
    }
    const capturedTreeHash = await treeHash(quarantinePath);
    if (capturedTreeHash !== change.installedTreeHash) {
      try {
        await rename(quarantinePath, change.targetPath);
        quarantinePath = undefined;
      } catch {
        // Leave the quarantined user content in place if restoration races.
      }
      return rollbackConflict(
        "Host asset changed during rollback; user content was preserved",
      );
    }
    await rm(quarantinePath, { recursive: true, force: true });
    quarantinePath = undefined;
    await cleanupEmptyDirectories(
      change.createdPaths.filter(
        (path) =>
          isAbsolute(path) &&
          !samePath(path, change.targetPath) &&
          isContained(path, change.targetPath),
      ),
    );
  } catch (error) {
    if (quarantinePath !== undefined) {
      try {
        await rename(quarantinePath, change.targetPath);
        quarantinePath = undefined;
      } catch {
        // Preserve the quarantined tree if another target appeared.
      }
    }
    if (error instanceof InstallerError) {
      if (error.code === "HOST_ASSET_INVALID") {
        return rollbackConflict(
          "Host asset is invalid during rollback; refusing to remove it",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset rollback failed",
    );
  }
}

export async function inspectHostAssetRollback(
  change: AppliedHostAssetChange,
): Promise<HostAssetRollbackStatus> {
  if (!change.changed) {
    return "unowned";
  }
  try {
    if (
      !isAbsolute(change.targetPath) ||
      !digestPattern.test(change.installedTreeHash)
    ) {
      return rollbackConflict("Host asset rollback evidence is invalid");
    }
    const currentTreeHash = await existingTreeHash(change.targetPath);
    if (currentTreeHash === undefined) {
      return "removed";
    }
    if (currentTreeHash !== change.installedTreeHash) {
      return rollbackConflict(
        "Host asset changed after installation; refusing to remove it",
      );
    }
    return "installed";
  } catch (error) {
    if (error instanceof InstallerError) {
      if (error.code === "HOST_ASSET_INVALID") {
        return rollbackConflict(
          "Host asset is invalid during rollback; refusing to remove it",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset rollback inspection failed",
    );
  }
}

export async function verifyHostAssetChange(
  change: AppliedHostAssetChange,
): Promise<void> {
  try {
    if (
      !isAbsolute(change.targetPath) ||
      !digestPattern.test(change.installedTreeHash)
    ) {
      return invalid("Host asset verification evidence is invalid");
    }
    const currentTreeHash = await existingTreeHash(change.targetPath);
    if (currentTreeHash !== change.installedTreeHash) {
      return conflict("Host asset changed before installation verification");
    }
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "HOST_ASSET_WRITE_FAILED",
      "Host asset verification failed",
    );
  }
}
