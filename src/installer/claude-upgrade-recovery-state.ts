import { basename, dirname, isAbsolute } from "node:path";

import { InstallerError } from "./errors.js";
import { isSafePluginVersion } from "./install-manifest.js";
import {
  claudeUpgradeRecoveryFileName,
  readUpgradeRecoveryDocument,
  removeUpgradeRecoveryDocument,
  replaceUpgradeRecoveryDocument,
} from "./upgrade-recovery.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface ClaudeUpgradeActivationEvidence {
  readonly pluginId: "huaweicloud-mate@huaweicloud-mate-local";
  readonly version: string;
  readonly installPath: string;
  readonly installedEntryHash: string;
}

export interface ClaudeUpgradeRecovery {
  readonly schemaVersion: 1;
  readonly host: "claude";
  readonly oldStateSha256: string;
  readonly oldPluginVersion: string;
  readonly oldInstallManifestSha256: string;
  readonly oldActiveRuntimeSha256: string;
  readonly candidatePluginVersion: string;
  readonly candidateInstallManifestSha256: string;
  readonly candidateAssetTreeHash: string;
  readonly candidateCatalogSha256: string;
  readonly candidateActivation?: ClaudeUpgradeActivationEvidence;
  readonly candidateActiveRuntimeSha256?: string;
  readonly restoredActivation?: ClaudeUpgradeActivationEvidence;
  readonly restoredStateSha256?: string;
}

export interface ClaudeUpgradeRecoverySnapshot {
  readonly recovery: ClaudeUpgradeRecovery;
  readonly sha256: string;
}

function invalid(message: string): never {
  throw new InstallerError("UPGRADE_RECOVERY_INVALID", message);
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

function parseActivation(
  value: unknown,
  candidateVersion: string,
): ClaudeUpgradeActivationEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "pluginId",
      "version",
      "installPath",
      "installedEntryHash",
    ]) ||
    value.pluginId !== "huaweicloud-mate@huaweicloud-mate-local" ||
    value.version !== candidateVersion ||
    typeof value.installPath !== "string" ||
    !isAbsolute(value.installPath) ||
    basename(value.installPath) !== candidateVersion ||
    basename(dirname(value.installPath)) !== "huaweicloud-mate" ||
    basename(dirname(dirname(value.installPath))) !==
      "huaweicloud-mate-local" ||
    !isDigest(value.installedEntryHash)
  ) {
    return invalid("Claude upgrade recovery activation evidence is invalid");
  }
  return {
    pluginId: "huaweicloud-mate@huaweicloud-mate-local",
    version: value.version,
    installPath: value.installPath,
    installedEntryHash: value.installedEntryHash,
  };
}

export function parseClaudeUpgradeRecovery(
  value: unknown,
): ClaudeUpgradeRecovery {
  if (!isRecord(value)) {
    return invalid("Claude upgrade recovery marker must be a JSON object");
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
    "candidateCatalogSha256",
    ...(value.candidateActivation === undefined ? [] : ["candidateActivation"]),
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? []
      : ["candidateActiveRuntimeSha256"]),
    ...(value.restoredActivation === undefined ? [] : ["restoredActivation"]),
    ...(value.restoredStateSha256 === undefined
      ? []
      : ["restoredStateSha256"]),
  ];
  if (
    !exactKeys(value, expectedKeys) ||
    value.schemaVersion !== 1 ||
    value.host !== "claude" ||
    !isDigest(value.oldStateSha256) ||
    typeof value.oldPluginVersion !== "string" ||
    !isSafePluginVersion(value.oldPluginVersion) ||
    !isDigest(value.oldInstallManifestSha256) ||
    !isDigest(value.oldActiveRuntimeSha256) ||
    typeof value.candidatePluginVersion !== "string" ||
    !isSafePluginVersion(value.candidatePluginVersion) ||
    !isDigest(value.candidateInstallManifestSha256) ||
    !isDigest(value.candidateAssetTreeHash) ||
    !isDigest(value.candidateCatalogSha256) ||
    (value.restoredStateSha256 !== undefined &&
      !isDigest(value.restoredStateSha256)) ||
    (value.oldPluginVersion === value.candidatePluginVersion &&
      value.oldInstallManifestSha256 === value.candidateInstallManifestSha256)
  ) {
    return invalid("Claude upgrade recovery marker is invalid");
  }
  if (
    value.candidateActiveRuntimeSha256 !== undefined &&
    (!isDigest(value.candidateActiveRuntimeSha256) ||
      value.candidateActivation === undefined)
  ) {
    return invalid("Claude upgrade recovery pointer evidence is invalid");
  }
  if (
    value.restoredStateSha256 !== undefined &&
    value.restoredActivation === undefined
  ) {
    return invalid("Claude restored state is missing activation evidence");
  }
  return {
    schemaVersion: 1,
    host: "claude",
    oldStateSha256: value.oldStateSha256,
    oldPluginVersion: value.oldPluginVersion,
    oldInstallManifestSha256: value.oldInstallManifestSha256,
    oldActiveRuntimeSha256: value.oldActiveRuntimeSha256,
    candidatePluginVersion: value.candidatePluginVersion,
    candidateInstallManifestSha256: value.candidateInstallManifestSha256,
    candidateAssetTreeHash: value.candidateAssetTreeHash,
    candidateCatalogSha256: value.candidateCatalogSha256,
    ...(value.candidateActivation === undefined
      ? {}
      : {
          candidateActivation: parseActivation(
            value.candidateActivation,
            value.candidatePluginVersion,
          ),
        }),
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? {}
      : { candidateActiveRuntimeSha256: value.candidateActiveRuntimeSha256 }),
    ...(value.restoredActivation === undefined
      ? {}
      : {
          restoredActivation: parseActivation(
            value.restoredActivation,
            value.oldPluginVersion,
          ),
        }),
    ...(value.restoredStateSha256 === undefined
      ? {}
      : { restoredStateSha256: value.restoredStateSha256 }),
  };
}

export async function readClaudeUpgradeRecovery(
  runtimeRoot: string,
): Promise<ClaudeUpgradeRecoverySnapshot | undefined> {
  const snapshot = await readUpgradeRecoveryDocument(
    runtimeRoot,
    claudeUpgradeRecoveryFileName,
  );
  return snapshot === undefined
    ? undefined
    : {
        recovery: parseClaudeUpgradeRecovery(snapshot.value),
        sha256: snapshot.sha256,
      };
}

export async function replaceClaudeUpgradeRecovery(
  runtimeRoot: string,
  recovery: ClaudeUpgradeRecovery,
  expectedSha256: string | null,
): Promise<ClaudeUpgradeRecoverySnapshot> {
  const normalized = parseClaudeUpgradeRecovery(recovery);
  const snapshot = await replaceUpgradeRecoveryDocument(
    runtimeRoot,
    claudeUpgradeRecoveryFileName,
    normalized,
    expectedSha256,
  );
  return { recovery: normalized, sha256: snapshot.sha256 };
}

export async function removeClaudeUpgradeRecovery(
  runtimeRoot: string,
  expectedSha256: string,
): Promise<void> {
  await removeUpgradeRecoveryDocument(
    runtimeRoot,
    claudeUpgradeRecoveryFileName,
    expectedSha256,
  );
}
