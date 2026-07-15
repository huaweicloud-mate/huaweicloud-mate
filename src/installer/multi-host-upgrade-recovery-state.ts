import type { HostId } from "../hosts/types.js";
import { InstallerError } from "./errors.js";
import { isSafePluginVersion } from "./install-manifest.js";
import {
  multiHostUpgradeRecoveryFileName,
  readUpgradeRecoveryDocument,
  removeUpgradeRecoveryDocument,
  replaceUpgradeRecoveryDocument,
} from "./upgrade-recovery.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const boundedTextPattern = /^.{1,512}$/u;

export interface MultiHostCodexActivationEvidence {
  readonly pluginId: string;
  readonly version: string;
  readonly installedEntryHash: string;
}

export interface MultiHostClaudeActivationEvidence {
  readonly pluginId: string;
  readonly version: string;
  readonly installPath: string;
  readonly installedEntryHash: string;
}

export interface MultiHostUpgradeHostRecovery {
  readonly id: HostId;
  readonly candidateAssetTreeHash: string;
  readonly candidateCatalogSha256?: string;
  readonly codexActivation?: MultiHostCodexActivationEvidence;
  readonly claudeActivation?: MultiHostClaudeActivationEvidence;
}

export interface MultiHostUpgradeRecovery {
  readonly schemaVersion: 1;
  readonly oldStateSha256: string;
  readonly oldPluginVersion: string;
  readonly oldInstallManifestSha256: string;
  readonly oldActiveRuntimeSha256: string;
  readonly candidatePluginVersion: string;
  readonly candidateInstallManifestSha256: string;
  readonly hosts: readonly MultiHostUpgradeHostRecovery[];
  readonly candidateActiveRuntimeSha256?: string;
}

export interface MultiHostUpgradeRecoverySnapshot {
  readonly recovery: MultiHostUpgradeRecovery;
  readonly sha256: string;
}

function invalid(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\n") ===
    [...expected].sort().join("\n");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && boundedTextPattern.test(value);
}

function parseCodexActivation(
  value: unknown,
): MultiHostCodexActivationEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["pluginId", "version", "installedEntryHash"]) ||
    !bounded(value.pluginId) ||
    !bounded(value.version) ||
    !isDigest(value.installedEntryHash)
  ) {
    return invalid("Multi-host Codex activation evidence is invalid");
  }
  return {
    pluginId: value.pluginId,
    version: value.version,
    installedEntryHash: value.installedEntryHash,
  };
}

function parseClaudeActivation(
  value: unknown,
): MultiHostClaudeActivationEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "pluginId",
      "version",
      "installPath",
      "installedEntryHash",
    ]) ||
    !bounded(value.pluginId) ||
    !bounded(value.version) ||
    !bounded(value.installPath) ||
    !isDigest(value.installedEntryHash)
  ) {
    return invalid("Multi-host Claude activation evidence is invalid");
  }
  return {
    pluginId: value.pluginId,
    version: value.version,
    installPath: value.installPath,
    installedEntryHash: value.installedEntryHash,
  };
}

function parseHost(value: unknown): MultiHostUpgradeHostRecovery {
  if (!isRecord(value)) {
    return invalid("Multi-host recovery host evidence must be an object");
  }
  const expected = [
    "id",
    "candidateAssetTreeHash",
    ...(value.candidateCatalogSha256 === undefined
      ? []
      : ["candidateCatalogSha256"]),
    ...(value.codexActivation === undefined ? [] : ["codexActivation"]),
    ...(value.claudeActivation === undefined ? [] : ["claudeActivation"]),
  ];
  if (
    !exactKeys(value, expected) ||
    (value.id !== "codex" &&
      value.id !== "claude" &&
      value.id !== "opencode" &&
      value.id !== "codearts") ||
    !isDigest(value.candidateAssetTreeHash) ||
    (value.candidateCatalogSha256 !== undefined &&
      !isDigest(value.candidateCatalogSha256)) ||
    (value.id === "claude") !==
      (value.candidateCatalogSha256 !== undefined) ||
    (value.codexActivation !== undefined && value.id !== "codex") ||
    (value.claudeActivation !== undefined && value.id !== "claude")
  ) {
    return invalid("Multi-host recovery host binding is invalid");
  }
  return {
    id: value.id,
    candidateAssetTreeHash: value.candidateAssetTreeHash,
    ...(value.candidateCatalogSha256 === undefined
      ? {}
      : { candidateCatalogSha256: value.candidateCatalogSha256 }),
    ...(value.codexActivation === undefined
      ? {}
      : { codexActivation: parseCodexActivation(value.codexActivation) }),
    ...(value.claudeActivation === undefined
      ? {}
      : { claudeActivation: parseClaudeActivation(value.claudeActivation) }),
  };
}

export function parseMultiHostUpgradeRecovery(
  value: unknown,
): MultiHostUpgradeRecovery {
  if (!isRecord(value)) {
    return invalid("Multi-host upgrade recovery marker must be an object");
  }
  const expected = [
    "schemaVersion",
    "oldStateSha256",
    "oldPluginVersion",
    "oldInstallManifestSha256",
    "oldActiveRuntimeSha256",
    "candidatePluginVersion",
    "candidateInstallManifestSha256",
    "hosts",
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? []
      : ["candidateActiveRuntimeSha256"]),
  ];
  if (
    !exactKeys(value, expected) ||
    value.schemaVersion !== 1 ||
    !isDigest(value.oldStateSha256) ||
    typeof value.oldPluginVersion !== "string" ||
    !isSafePluginVersion(value.oldPluginVersion) ||
    !isDigest(value.oldInstallManifestSha256) ||
    !isDigest(value.oldActiveRuntimeSha256) ||
    typeof value.candidatePluginVersion !== "string" ||
    !isSafePluginVersion(value.candidatePluginVersion) ||
    !isDigest(value.candidateInstallManifestSha256) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length < 2 ||
    value.hosts.length > 4 ||
    (value.candidateActiveRuntimeSha256 !== undefined &&
      !isDigest(value.candidateActiveRuntimeSha256)) ||
    (value.oldPluginVersion === value.candidatePluginVersion &&
      value.oldInstallManifestSha256 ===
        value.candidateInstallManifestSha256)
  ) {
    return invalid("Multi-host upgrade recovery marker is invalid");
  }
  const hosts = value.hosts.map(parseHost);
  if (
    new Set(hosts.map((host) => host.id)).size !== hosts.length ||
    hosts.some((host, index) => index > 0 && hosts[index - 1]!.id >= host.id)
  ) {
    return invalid("Multi-host recovery hosts must be unique and sorted");
  }
  return {
    schemaVersion: 1,
    oldStateSha256: value.oldStateSha256,
    oldPluginVersion: value.oldPluginVersion,
    oldInstallManifestSha256: value.oldInstallManifestSha256,
    oldActiveRuntimeSha256: value.oldActiveRuntimeSha256,
    candidatePluginVersion: value.candidatePluginVersion,
    candidateInstallManifestSha256: value.candidateInstallManifestSha256,
    hosts,
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? {}
      : { candidateActiveRuntimeSha256: value.candidateActiveRuntimeSha256 }),
  };
}

export async function readMultiHostUpgradeRecovery(
  runtimeRoot: string,
): Promise<MultiHostUpgradeRecoverySnapshot | undefined> {
  const snapshot = await readUpgradeRecoveryDocument(
    runtimeRoot,
    multiHostUpgradeRecoveryFileName,
  );
  return snapshot === undefined
    ? undefined
    : {
        recovery: parseMultiHostUpgradeRecovery(snapshot.value),
        sha256: snapshot.sha256,
      };
}

export async function replaceMultiHostUpgradeRecovery(
  runtimeRoot: string,
  recovery: MultiHostUpgradeRecovery,
  expectedSha256: string | null,
): Promise<MultiHostUpgradeRecoverySnapshot> {
  const normalized = parseMultiHostUpgradeRecovery(recovery);
  const snapshot = await replaceUpgradeRecoveryDocument(
    runtimeRoot,
    multiHostUpgradeRecoveryFileName,
    normalized,
    expectedSha256,
  );
  return { recovery: normalized, sha256: snapshot.sha256 };
}

export async function removeMultiHostUpgradeRecovery(
  runtimeRoot: string,
  expectedSha256: string,
): Promise<void> {
  await removeUpgradeRecoveryDocument(
    runtimeRoot,
    multiHostUpgradeRecoveryFileName,
    expectedSha256,
  );
}
