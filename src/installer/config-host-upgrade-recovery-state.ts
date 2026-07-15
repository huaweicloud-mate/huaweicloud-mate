import { InstallerError } from "./errors.js";
import { isSafePluginVersion } from "./install-manifest.js";
import type { ConfigHostId } from "./config-host-installation.js";
import {
  configHostUpgradeRecoveryFileName,
  readUpgradeRecoveryDocument,
  removeUpgradeRecoveryDocument,
  replaceUpgradeRecoveryDocument,
} from "./upgrade-recovery.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface ConfigHostUpgradeRecovery {
  readonly schemaVersion: 1;
  readonly host: ConfigHostId;
  readonly oldStateSha256: string;
  readonly oldPluginVersion: string;
  readonly oldInstallManifestSha256: string;
  readonly oldActiveRuntimeSha256: string;
  readonly candidatePluginVersion: string;
  readonly candidateInstallManifestSha256: string;
  readonly candidateAssetTreeHash: string;
  readonly candidateActiveRuntimeSha256?: string;
}

export interface ConfigHostUpgradeRecoverySnapshot {
  readonly recovery: ConfigHostUpgradeRecovery;
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

export function parseConfigHostUpgradeRecovery(
  value: unknown,
): ConfigHostUpgradeRecovery {
  if (!isRecord(value)) {
    return invalid("Config-host upgrade recovery marker must be a JSON object");
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
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? []
      : ["candidateActiveRuntimeSha256"]),
  ];
  if (
    !exactKeys(value, expectedKeys) ||
    value.schemaVersion !== 1 ||
    (value.host !== "opencode" && value.host !== "codearts") ||
    !isDigest(value.oldStateSha256) ||
    typeof value.oldPluginVersion !== "string" ||
    !isSafePluginVersion(value.oldPluginVersion) ||
    !isDigest(value.oldInstallManifestSha256) ||
    !isDigest(value.oldActiveRuntimeSha256) ||
    typeof value.candidatePluginVersion !== "string" ||
    !isSafePluginVersion(value.candidatePluginVersion) ||
    !isDigest(value.candidateInstallManifestSha256) ||
    !isDigest(value.candidateAssetTreeHash) ||
    (value.candidateActiveRuntimeSha256 !== undefined &&
      !isDigest(value.candidateActiveRuntimeSha256)) ||
    (value.oldPluginVersion === value.candidatePluginVersion &&
      value.oldInstallManifestSha256 === value.candidateInstallManifestSha256)
  ) {
    return invalid("Config-host upgrade recovery marker is invalid");
  }
  return {
    schemaVersion: 1,
    host: value.host,
    oldStateSha256: value.oldStateSha256,
    oldPluginVersion: value.oldPluginVersion,
    oldInstallManifestSha256: value.oldInstallManifestSha256,
    oldActiveRuntimeSha256: value.oldActiveRuntimeSha256,
    candidatePluginVersion: value.candidatePluginVersion,
    candidateInstallManifestSha256: value.candidateInstallManifestSha256,
    candidateAssetTreeHash: value.candidateAssetTreeHash,
    ...(value.candidateActiveRuntimeSha256 === undefined
      ? {}
      : { candidateActiveRuntimeSha256: value.candidateActiveRuntimeSha256 }),
  };
}

export async function readConfigHostUpgradeRecovery(
  runtimeRoot: string,
): Promise<ConfigHostUpgradeRecoverySnapshot | undefined> {
  const snapshot = await readUpgradeRecoveryDocument(
    runtimeRoot,
    configHostUpgradeRecoveryFileName,
  );
  return snapshot === undefined
    ? undefined
    : {
        recovery: parseConfigHostUpgradeRecovery(snapshot.value),
        sha256: snapshot.sha256,
      };
}

export async function replaceConfigHostUpgradeRecovery(
  runtimeRoot: string,
  recovery: ConfigHostUpgradeRecovery,
  expectedSha256: string | null,
): Promise<ConfigHostUpgradeRecoverySnapshot> {
  const normalized = parseConfigHostUpgradeRecovery(recovery);
  const snapshot = await replaceUpgradeRecoveryDocument(
    runtimeRoot,
    configHostUpgradeRecoveryFileName,
    normalized,
    expectedSha256,
  );
  return { recovery: normalized, sha256: snapshot.sha256 };
}

export async function removeConfigHostUpgradeRecovery(
  runtimeRoot: string,
  expectedSha256: string,
): Promise<void> {
  await removeUpgradeRecoveryDocument(
    runtimeRoot,
    configHostUpgradeRecoveryFileName,
    expectedSha256,
  );
}
