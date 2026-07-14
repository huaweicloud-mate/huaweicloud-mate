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
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { approvalIssuerId } from "../approval/constants.js";
import type { HostInstallPlan } from "../hosts/plan.js";
import type { HostId } from "../hosts/types.js";
import type { AppliedHostConfigChange } from "./config-transaction.js";
import type { AppliedCodexMarketplaceChange } from "./codex-marketplace.js";
import { InstallerError } from "./errors.js";
import type { AppliedHostAssetChange } from "./host-assets.js";
import {
  isSafePluginVersion,
  verifyInstallDirectory,
} from "./install-manifest.js";
import type { MaterializedRuntime } from "./runtime.js";

export const installStateFileName = "install-state.json";

const maxInstallStateBytes = 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const hostIds = ["claude", "codearts", "codex", "opencode"] as const;
const mergeStrategies = [
  "json-object",
  "jsonc-object",
  "plugin-manifest",
] as const;

export interface InstallStateConfigEvidence {
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly beforeSha256?: string;
  readonly backupPath?: string;
  readonly backupSha256?: string;
}

export interface InstallStateAssetEvidence {
  readonly kind: "plugin" | "skill";
  readonly targetPath: string;
  readonly changed: boolean;
  readonly installedTreeHash: string;
  readonly createdPaths: readonly string[];
}

export interface InstallStateCodexRegistrationEvidence {
  readonly kind: "codex-personal-marketplace";
  readonly marketplacePath: string;
  readonly marketplaceName: string;
  readonly pluginPath: string;
  readonly pluginName: "huaweicloud-mate";
  readonly sourcePath: "./plugins/huaweicloud-mate";
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly installedSha256: string;
  readonly installedEntryHash: string;
  readonly beforeSha256?: string;
  readonly backupPath?: string;
  readonly backupSha256?: string;
}

export interface InstallStateHost {
  readonly id: HostId;
  readonly mergeStrategy: (typeof mergeStrategies)[number];
  readonly configPath: string;
  readonly entryKey: "huaweicloud-agent";
  readonly installedValueHash: string;
  readonly approvalIssuerId: typeof approvalIssuerId;
  readonly config?: InstallStateConfigEvidence;
  readonly registration?: InstallStateCodexRegistrationEvidence;
  readonly asset: InstallStateAssetEvidence;
}

export interface InstallState {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  readonly installManifestSha256: string;
  readonly runtimePath: string;
  readonly stableLauncherPath: string;
  readonly hosts: readonly InstallStateHost[];
}

export interface CompletedHostInstallation {
  readonly plan: HostInstallPlan;
  readonly assetChange: AppliedHostAssetChange;
  readonly configChange?: AppliedHostConfigChange;
  readonly registrationChange?: AppliedCodexMarketplaceChange;
}

export interface InstallStateSnapshot {
  readonly state: InstallState;
  readonly sha256: string;
}

export interface AppliedInstallStateChange {
  readonly statePath: string;
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

function invalid(message: string): never {
  throw new InstallerError("INSTALL_STATE_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("INSTALL_STATE_CONFLICT", message);
}

function rollbackConflict(message: string): never {
  throw new InstallerError("INSTALL_STATE_ROLLBACK_CONFLICT", message);
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

function isHostId(value: unknown): value is HostId {
  return typeof value === "string" && hostIds.includes(value as HostId);
}

function isMergeStrategy(
  value: unknown,
): value is (typeof mergeStrategies)[number] {
  return (
    typeof value === "string" &&
    mergeStrategies.includes(value as (typeof mergeStrategies)[number])
  );
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

function canonicalizeJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        return invalid("Install state source contains a non-finite number");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        return invalid("Install state source contains a cycle");
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
          return invalid("Install state source contains a non-JSON object");
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
      return invalid("Install state source contains a non-JSON value");
  }
}

function installedValueHash(plan: HostInstallPlan): string {
  const rootName = plan.mergeStrategy === "plugin-manifest"
    ? "mcpServers"
    : "mcp";
  if (!isRecord(plan.configFragment) || !exactKeys(plan.configFragment, [rootName])) {
    return invalid("Install plan config fragment has an unexpected root");
  }
  const root = plan.configFragment[rootName];
  if (
    !isRecord(root) ||
    !exactKeys(root, [plan.entryKey]) ||
    !isRecord(root[plan.entryKey])
  ) {
    return invalid("Install plan config fragment has an unexpected entry");
  }
  return digest(Buffer.from(canonicalizeJson(root[plan.entryKey]), "utf8"));
}

function parseConfigEvidence(value: unknown): InstallStateConfigEvidence {
  if (!isRecord(value)) {
    return invalid("Install state config evidence is not an object");
  }
  const optionalKeys = ["beforeSha256", "backupPath", "backupSha256"].filter(
    (key) => value[key] !== undefined,
  );
  if (
    !exactKeys(value, [
      "changed",
      "createdFile",
      "installedSha256",
      ...optionalKeys,
    ]) ||
    typeof value.changed !== "boolean" ||
    typeof value.createdFile !== "boolean" ||
    !isDigest(value.installedSha256)
  ) {
    return invalid("Install state config evidence is invalid");
  }

  const beforeSha256 = value.beforeSha256;
  const backupPath = value.backupPath;
  const backupSha256 = value.backupSha256;
  if (!value.changed) {
    if (
      value.createdFile ||
      beforeSha256 !== undefined ||
      backupPath !== undefined ||
      backupSha256 !== undefined
    ) {
      return invalid("Unchanged config evidence claims transaction ownership");
    }
  } else if (value.createdFile) {
    if (
      beforeSha256 !== undefined ||
      backupPath !== undefined ||
      backupSha256 !== undefined
    ) {
      return invalid("New config evidence contains an unexpected backup");
    }
  } else if (
    !isDigest(beforeSha256) ||
    typeof backupPath !== "string" ||
    !isAbsolute(backupPath) ||
    !isDigest(backupSha256) ||
    beforeSha256 !== backupSha256
  ) {
    return invalid("Existing config evidence is missing its verified backup");
  }

  return {
    changed: value.changed,
    createdFile: value.createdFile,
    installedSha256: value.installedSha256,
    ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
    ...(backupPath === undefined ? {} : { backupPath: resolve(backupPath) }),
    ...(backupSha256 === undefined ? {} : { backupSha256 }),
  };
}

function parseAssetEvidence(value: unknown): InstallStateAssetEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "kind",
      "targetPath",
      "changed",
      "installedTreeHash",
      "createdPaths",
    ]) ||
    (value.kind !== "plugin" && value.kind !== "skill") ||
    typeof value.targetPath !== "string" ||
    !isAbsolute(value.targetPath) ||
    typeof value.changed !== "boolean" ||
    !isDigest(value.installedTreeHash) ||
    !Array.isArray(value.createdPaths)
  ) {
    return invalid("Install state asset evidence is invalid");
  }
  const targetPath = resolve(value.targetPath);
  const createdPaths: string[] = [];
  const seen = new Set<string>();
  for (const path of value.createdPaths) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      return invalid("Install state created path is not absolute");
    }
    const resolved = resolve(path);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (
      seen.has(key) ||
      (!samePath(resolved, targetPath) && !isContained(resolved, targetPath))
    ) {
      return invalid("Install state created path is duplicated or unrelated");
    }
    seen.add(key);
    createdPaths.push(resolved);
  }
  if (
    value.changed !== (createdPaths.length > 0) ||
    (value.changed && !createdPaths.some((path) => samePath(path, targetPath)))
  ) {
    return invalid("Install state asset ownership evidence is inconsistent");
  }
  return {
    kind: value.kind,
    targetPath,
    changed: value.changed,
    installedTreeHash: value.installedTreeHash,
    createdPaths,
  };
}

function parseCodexRegistrationEvidence(
  value: unknown,
): InstallStateCodexRegistrationEvidence {
  if (!isRecord(value)) {
    return invalid("Install state Codex registration evidence is not an object");
  }
  const optionalKeys = ["beforeSha256", "backupPath", "backupSha256"].filter(
    (key) => value[key] !== undefined,
  );
  if (
    !exactKeys(value, [
      "kind",
      "marketplacePath",
      "marketplaceName",
      "pluginPath",
      "pluginName",
      "sourcePath",
      "changed",
      "createdFile",
      "installedSha256",
      "installedEntryHash",
      ...optionalKeys,
    ]) ||
    value.kind !== "codex-personal-marketplace" ||
    typeof value.marketplacePath !== "string" ||
    !isAbsolute(value.marketplacePath) ||
    typeof value.marketplaceName !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(value.marketplaceName) ||
    typeof value.pluginPath !== "string" ||
    !isAbsolute(value.pluginPath) ||
    value.pluginName !== "huaweicloud-mate" ||
    value.sourcePath !== "./plugins/huaweicloud-mate" ||
    typeof value.changed !== "boolean" ||
    typeof value.createdFile !== "boolean" ||
    !isDigest(value.installedSha256) ||
    !isDigest(value.installedEntryHash)
  ) {
    return invalid("Install state Codex registration evidence is invalid");
  }
  const marketplacePath = resolve(value.marketplacePath);
  const pluginPath = resolve(value.pluginPath);
  const homeDirectory = dirname(dirname(pluginPath));
  if (
    basename(pluginPath) !== "huaweicloud-mate" ||
    basename(dirname(pluginPath)) !== "plugins" ||
    !samePath(
      marketplacePath,
      resolve(homeDirectory, ".agents", "plugins", "marketplace.json"),
    )
  ) {
    return invalid("Install state Codex registration paths are inconsistent");
  }
  const beforeSha256 = value.beforeSha256;
  const backupPath = value.backupPath;
  const backupSha256 = value.backupSha256;
  if (!value.changed) {
    if (
      value.createdFile ||
      beforeSha256 !== undefined ||
      backupPath !== undefined ||
      backupSha256 !== undefined
    ) {
      return invalid("Unchanged Codex registration claims transaction ownership");
    }
  } else if (value.createdFile) {
    if (
      beforeSha256 !== undefined ||
      backupPath !== undefined ||
      backupSha256 !== undefined
    ) {
      return invalid("New Codex registration contains an unexpected backup");
    }
  } else if (
    !isDigest(beforeSha256) ||
    typeof backupPath !== "string" ||
    !isAbsolute(backupPath) ||
    !isDigest(backupSha256) ||
    beforeSha256 !== backupSha256
  ) {
    return invalid("Existing Codex registration is missing its verified backup");
  }
  return {
    kind: "codex-personal-marketplace",
    marketplacePath,
    marketplaceName: value.marketplaceName,
    pluginPath,
    pluginName: "huaweicloud-mate",
    sourcePath: "./plugins/huaweicloud-mate",
    changed: value.changed,
    createdFile: value.createdFile,
    installedSha256: value.installedSha256,
    installedEntryHash: value.installedEntryHash,
    ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
    ...(backupPath === undefined ? {} : { backupPath: resolve(backupPath) }),
    ...(backupSha256 === undefined ? {} : { backupSha256 }),
  };
}

function parseHost(value: unknown): InstallStateHost {
  if (!isRecord(value)) {
    return invalid("Install state host is not an object");
  }
  const hasConfig = value.config !== undefined;
  const hasRegistration = value.registration !== undefined;
  if (
    !exactKeys(value, [
      "id",
      "mergeStrategy",
      "configPath",
      "entryKey",
      "installedValueHash",
      "approvalIssuerId",
      ...(hasConfig ? ["config"] : []),
      ...(hasRegistration ? ["registration"] : []),
      "asset",
    ]) ||
    !isHostId(value.id) ||
    !isMergeStrategy(value.mergeStrategy) ||
    typeof value.configPath !== "string" ||
    !isAbsolute(value.configPath) ||
    value.entryKey !== "huaweicloud-agent" ||
    !isDigest(value.installedValueHash) ||
    value.approvalIssuerId !== approvalIssuerId
  ) {
    return invalid("Install state host binding is invalid");
  }
  const asset = parseAssetEvidence(value.asset);
  const registration = hasRegistration
    ? parseCodexRegistrationEvidence(value.registration)
    : undefined;
  if (
    (value.mergeStrategy === "plugin-manifest") !== (asset.kind === "plugin") ||
    (value.mergeStrategy === "plugin-manifest") === hasConfig ||
    (value.id === "codex") !== hasRegistration
  ) {
    return invalid("Install state host transaction shape is invalid");
  }
  if (
    asset.kind === "plugin" &&
    !samePath(resolve(value.configPath), resolve(asset.targetPath, ".mcp.json"))
  ) {
    return invalid("Plugin install state config path is outside its asset tree");
  }
  if (
    registration !== undefined &&
    !samePath(registration.pluginPath, asset.targetPath)
  ) {
    return invalid("Codex registration does not reference its plugin asset");
  }
  return {
    id: value.id,
    mergeStrategy: value.mergeStrategy,
    configPath: resolve(value.configPath),
    entryKey: "huaweicloud-agent",
    installedValueHash: value.installedValueHash,
    approvalIssuerId,
    ...(hasConfig ? { config: parseConfigEvidence(value.config) } : {}),
    ...(registration === undefined ? {} : { registration }),
    asset,
  };
}

export function parseInstallState(value: unknown): InstallState {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "pluginVersion",
      "installManifestSha256",
      "runtimePath",
      "stableLauncherPath",
      "hosts",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.pluginVersion !== "string" ||
    !isSafePluginVersion(value.pluginVersion) ||
    !isDigest(value.installManifestSha256) ||
    typeof value.runtimePath !== "string" ||
    !isAbsolute(value.runtimePath) ||
    typeof value.stableLauncherPath !== "string" ||
    !isAbsolute(value.stableLauncherPath) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length === 0 ||
    value.hosts.length > hostIds.length
  ) {
    return invalid("Install state header is invalid");
  }
  const hosts = value.hosts.map(parseHost);
  const ids = hosts.map((host) => host.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.join("\n") !== [...ids].sort().join("\n")
  ) {
    return invalid("Install state hosts must be unique and sorted");
  }
  return {
    schemaVersion: 1,
    pluginVersion: value.pluginVersion,
    installManifestSha256: value.installManifestSha256,
    runtimePath: resolve(value.runtimePath),
    stableLauncherPath: resolve(value.stableLauncherPath),
    hosts,
  };
}

function bindStateToRuntime(state: InstallState, runtimeRoot: string): void {
  const root = resolve(runtimeRoot);
  const expectedRuntimePath = resolve(root, "versions", state.pluginVersion);
  const expectedLauncherPath = resolve(root, "current", "hcloud-agent.mjs");
  if (
    !isAbsolute(runtimeRoot) ||
    !samePath(state.runtimePath, expectedRuntimePath) ||
    !samePath(state.stableLauncherPath, expectedLauncherPath)
  ) {
    return invalid("Install state runtime paths do not match the fixed layout");
  }
}

async function verifyStateRuntime(state: InstallState): Promise<void> {
  try {
    const verified = await verifyInstallDirectory(
      state.runtimePath,
      state.installManifestSha256,
    );
    if (verified.manifest.pluginVersion !== state.pluginVersion) {
      return invalid("Install state version does not match its runtime manifest");
    }
  } catch (error) {
    if (
      error instanceof InstallerError &&
      error.code === "INSTALL_STATE_INVALID"
    ) {
      throw error;
    }
    return invalid("Install state runtime artifacts could not be verified");
  }
}

function configEvidence(
  change: AppliedHostConfigChange,
): InstallStateConfigEvidence {
  return parseConfigEvidence({
    changed: change.changed,
    createdFile: change.createdFile,
    installedSha256: change.installedSha256,
    ...(change.beforeSha256 === undefined
      ? {}
      : { beforeSha256: change.beforeSha256 }),
    ...(change.backupPath === undefined ? {} : { backupPath: change.backupPath }),
    ...(change.backupSha256 === undefined
      ? {}
      : { backupSha256: change.backupSha256 }),
  });
}

function assetEvidence(change: AppliedHostAssetChange): InstallStateAssetEvidence {
  return parseAssetEvidence({
    kind: change.kind,
    targetPath: change.targetPath,
    changed: change.changed,
    installedTreeHash: change.installedTreeHash,
    createdPaths: [...change.createdPaths],
  });
}

function codexRegistrationEvidence(
  change: AppliedCodexMarketplaceChange,
): InstallStateCodexRegistrationEvidence {
  return parseCodexRegistrationEvidence({
    kind: "codex-personal-marketplace",
    marketplacePath: change.marketplacePath,
    marketplaceName: change.marketplaceName,
    pluginPath: change.pluginPath,
    pluginName: change.pluginName,
    sourcePath: change.sourcePath,
    changed: change.changed,
    createdFile: change.createdFile,
    installedSha256: change.installedSha256,
    installedEntryHash: change.installedEntryHash,
    ...(change.changed && change.beforeSha256 !== undefined
      ? { beforeSha256: change.beforeSha256 }
      : {}),
    ...(change.backupPath === undefined ? {} : { backupPath: change.backupPath }),
    ...(change.backupSha256 === undefined
      ? {}
      : { backupSha256: change.backupSha256 }),
  });
}

function hostState(completed: CompletedHostInstallation): InstallStateHost {
  const { plan, assetChange, configChange, registrationChange } = completed;
  const isPlugin = plan.mergeStrategy === "plugin-manifest";
  const expectedAssetTarget = isPlugin
    ? plan.pluginTargetPath
    : plan.skillTargetPath;
  if (
    plan.id !== assetChange.hostId ||
    expectedAssetTarget === undefined ||
    !samePath(expectedAssetTarget, assetChange.targetPath) ||
    (!isPlugin && !samePath(plan.skillSourcePath, assetChange.sourcePath)) ||
    (isPlugin && !samePath(plan.pluginSourcePath ?? "", assetChange.sourcePath)) ||
    isPlugin !== (assetChange.kind === "plugin") ||
    isPlugin === (configChange !== undefined) ||
    (plan.id === "codex") !== (registrationChange !== undefined)
  ) {
    return invalid("Completed host installation does not match its plan");
  }
  if (
    configChange !== undefined &&
    (!samePath(configChange.configPath, plan.configPath) ||
      configChange.entryKey !== plan.entryKey ||
      configChange.mergeStrategy !== plan.mergeStrategy)
  ) {
    return invalid("Completed host config change does not match its plan");
  }
  const valueHash = installedValueHash(plan);
  if (
    configChange !== undefined &&
    configChange.installedValueHash !== valueHash
  ) {
    return invalid("Completed host config value hash does not match its plan");
  }
  if (
    registrationChange !== undefined &&
    (!samePath(registrationChange.pluginPath, assetChange.targetPath) ||
      registrationChange.pluginName !== "huaweicloud-mate" ||
      registrationChange.sourcePath !== "./plugins/huaweicloud-mate")
  ) {
    return invalid("Completed Codex registration does not match its plan");
  }
  return parseHost({
    id: plan.id,
    mergeStrategy: plan.mergeStrategy,
    configPath: plan.configPath,
    entryKey: plan.entryKey,
    installedValueHash: valueHash,
    approvalIssuerId,
    ...(configChange === undefined ? {} : { config: configEvidence(configChange) }),
    ...(registrationChange === undefined
      ? {}
      : { registration: codexRegistrationEvidence(registrationChange) }),
    asset: assetEvidence(assetChange),
  });
}

export function createInstallState(
  runtime: MaterializedRuntime,
  completedHosts: readonly CompletedHostInstallation[],
): InstallState {
  const state = parseInstallState({
    schemaVersion: 1,
    pluginVersion: runtime.pluginVersion,
    installManifestSha256: runtime.installManifestSha256,
    runtimePath: runtime.versionDirectory,
    stableLauncherPath: runtime.stableLauncherPath,
    hosts: completedHosts
      .map(hostState)
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
  bindStateToRuntime(state, runtime.runtimeRoot);
  return state;
}

export function installStatePath(runtimeRoot: string): string {
  if (!isAbsolute(runtimeRoot)) {
    return invalid("Install state runtime root must be absolute");
  }
  return resolve(runtimeRoot, installStateFileName);
}

async function assertRuntimeRoot(runtimeRoot: string): Promise<string> {
  const root = resolve(runtimeRoot);
  if (!isAbsolute(runtimeRoot)) {
    return invalid("Install state runtime root must be absolute");
  }
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return invalid("Install state runtime root is not a regular directory");
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
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > maxInstallStateBytes
  ) {
    return invalid("Install state must be a regular file within the size limit");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size || bytes.byteLength > maxInstallStateBytes) {
    return invalid("Install state changed while it was being read");
  }
  return { exists: true, bytes, sha256: digest(bytes) };
}

function decodeState(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Install state is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid("Install state is not valid JSON");
  }
}

export async function readInstallState(
  runtimeRoot: string,
): Promise<InstallStateSnapshot | undefined> {
  try {
    const root = await assertRuntimeRoot(runtimeRoot);
    const snapshot = await readSnapshot(installStatePath(root));
    if (!snapshot.exists || snapshot.bytes === undefined || snapshot.sha256 === undefined) {
      return undefined;
    }
    const state = parseInstallState(decodeState(snapshot.bytes));
    bindStateToRuntime(state, root);
    await verifyStateRuntime(state);
    return { state, sha256: snapshot.sha256 };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError("INSTALL_STATE_INVALID", "Install state could not be read");
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

function snapshotMatches(
  snapshot: FileSnapshot,
  expectedSha256: string | null,
): boolean {
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
      return conflict("Install state changed during the transaction");
    }
    if (expectedSha256 === null) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (isAlreadyPresent(error)) {
          return conflict("Install state appeared during the transaction");
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
      // The state is committed; a same-user race may leave only the temp link.
    }
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
    // Never overwrite a target that appeared while rollback was in progress.
    return false;
  }
}

export async function replaceInstallState(
  runtimeRoot: string,
  state: InstallState,
  expectedSha256: string | null,
): Promise<AppliedInstallStateChange> {
  try {
    if (expectedSha256 !== null && !digestPattern.test(expectedSha256)) {
      return invalid("Expected install state digest is invalid");
    }
    const root = await assertRuntimeRoot(runtimeRoot);
    const normalized = parseInstallState(state);
    bindStateToRuntime(normalized, root);
    await verifyStateRuntime(normalized);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    if (bytes.byteLength > maxInstallStateBytes) {
      return invalid("Rendered install state exceeds the size limit");
    }
    const path = installStatePath(root);
    const before = await readSnapshot(path);
    if (!snapshotMatches(before, expectedSha256)) {
      return conflict("Install state no longer matches the expected digest");
    }
    const installedSha256 = digest(bytes);
    if (before.exists && before.sha256 === installedSha256) {
      return {
        statePath: path,
        changed: false,
        createdFile: false,
        installedSha256,
      };
    }
    await commitBytes(path, bytes, expectedSha256);
    return {
      statePath: path,
      changed: true,
      createdFile: !before.exists,
      installedSha256,
      ...(before.sha256 === undefined ? {} : { beforeSha256: before.sha256 }),
      ...(before.bytes === undefined ? {} : { beforeBytes: Buffer.from(before.bytes) }),
    };
  } catch (error) {
    if (error instanceof InstallerError) {
      throw error;
    }
    throw new InstallerError(
      "INSTALL_STATE_WRITE_FAILED",
      "Install state transaction failed",
    );
  }
}

export async function rollbackInstallStateChange(
  change: AppliedInstallStateChange,
): Promise<void> {
  if (!change.changed) {
    return;
  }
  let quarantinePath: string | undefined;
  try {
    if (!isAbsolute(change.statePath) || basename(change.statePath) !== installStateFileName) {
      return rollbackConflict("Install state rollback path is invalid");
    }
    const current = await readSnapshot(change.statePath);
    if (!current.exists || current.sha256 !== change.installedSha256) {
      return rollbackConflict(
        "Install state changed after installation; refusing to roll it back",
      );
    }
    if (change.createdFile) {
      quarantinePath = resolve(
        dirname(change.statePath),
        `.${installStateFileName}.${randomBytes(16).toString("hex")}.rollback`,
      );
      await rename(change.statePath, quarantinePath);
      const captured = await readSnapshot(quarantinePath);
      if (captured.sha256 !== change.installedSha256) {
        if (await restoreQuarantine(quarantinePath, change.statePath)) {
          quarantinePath = undefined;
        }
        return rollbackConflict(
          "Install state changed during rollback; refusing to remove it",
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
      return rollbackConflict("Install state rollback evidence is incomplete");
    }
    const previous = parseInstallState(decodeState(change.beforeBytes));
    const runtimeRoot = dirname(change.statePath);
    bindStateToRuntime(previous, runtimeRoot);
    await verifyStateRuntime(previous);
    await commitBytes(
      change.statePath,
      change.beforeBytes,
      change.installedSha256,
    );
  } catch (error) {
    if (quarantinePath !== undefined) {
      if (await restoreQuarantine(quarantinePath, change.statePath)) {
        quarantinePath = undefined;
      }
    }
    if (error instanceof InstallerError) {
      if (
        error.code === "INSTALL_STATE_INVALID" ||
        error.code === "INSTALL_STATE_CONFLICT"
      ) {
        return rollbackConflict(
          "Install state changed during rollback; refusing to overwrite it",
        );
      }
      throw error;
    }
    throw new InstallerError(
      "INSTALL_STATE_WRITE_FAILED",
      "Install state rollback failed",
    );
  }
}
