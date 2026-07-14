import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { InstallerError } from "./errors.js";

export const installManifestFileName = "install-manifest.json";
export const stableLauncherArtifactPath = "installer/stable-launcher.js";

const requiredRuntimeArtifacts = [
  stableLauncherArtifactPath,
  "package.json",
  "runtime/cli.js",
  "runtime-manifest.json",
] as const;
const maxManifestBytes = 8 * 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxRuntimeBytes = 512 * 1024 * 1024;
const maxArtifactCount = 4096;
const safeVersionPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const safeArtifactPathPattern =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export interface InstallArtifact {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface InstallManifest {
  readonly schemaVersion: "huaweicloud-mate-install-manifest/v1";
  readonly packageName: "huaweicloud-mate";
  readonly pluginVersion: string;
  readonly artifacts: readonly InstallArtifact[];
}

export interface VerifiedInstallDirectory {
  readonly manifest: InstallManifest;
  readonly manifestSha256: string;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function invalid(message: string): never {
  throw new InstallerError("RUNTIME_ARTIFACT_INVALID", message);
}

export function isSafePluginVersion(value: string): boolean {
  return safeVersionPattern.test(value) && value !== "." && value !== "..";
}

export function parseInstallManifest(value: unknown): InstallManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("Install manifest is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "schemaVersion",
      "packageName",
      "pluginVersion",
      "artifacts",
    ]) ||
    record.schemaVersion !== "huaweicloud-mate-install-manifest/v1" ||
    record.packageName !== "huaweicloud-mate" ||
    typeof record.pluginVersion !== "string" ||
    !isSafePluginVersion(record.pluginVersion) ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length === 0 ||
    record.artifacts.length > maxArtifactCount
  ) {
    return invalid("Install manifest header is invalid");
  }

  let totalBytes = 0;
  let previousPath = "";
  const seenPaths = new Set<string>();
  const artifacts = record.artifacts.map((value): InstallArtifact => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid("Install manifest artifact is not an object");
    }
    const artifact = value as Record<string, unknown>;
    if (
      !exactKeys(artifact, ["path", "size", "sha256"]) ||
      typeof artifact.path !== "string" ||
      !safeArtifactPathPattern.test(artifact.path) ||
      artifact.path.split("/").some((segment) => segment === "." || segment === "..") ||
      artifact.path === installManifestFileName ||
      seenPaths.has(artifact.path) ||
      artifact.path <= previousPath ||
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > maxArtifactBytes ||
      typeof artifact.sha256 !== "string" ||
      !digestPattern.test(artifact.sha256)
    ) {
      return invalid("Install manifest artifact is invalid");
    }
    seenPaths.add(artifact.path);
    previousPath = artifact.path;
    totalBytes += artifact.size;
    if (totalBytes > maxRuntimeBytes) {
      return invalid("Install manifest runtime size exceeds the limit");
    }
    return {
      path: artifact.path,
      size: artifact.size,
      sha256: artifact.sha256,
    };
  });

  if (requiredRuntimeArtifacts.some((path) => !seenPaths.has(path))) {
    return invalid("Install manifest is missing a required runtime artifact");
  }
  return {
    schemaVersion: "huaweicloud-mate-install-manifest/v1",
    packageName: "huaweicloud-mate",
    pluginVersion: record.pluginVersion,
    artifacts,
  };
}

function resolveContained(root: string, relativePath: string): string {
  const candidate = resolve(root, ...relativePath.split("/"));
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    return invalid("Runtime artifact path escapes the version directory");
  }
  return candidate;
}

async function assertRegularPath(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return invalid("Runtime artifact path is incomplete");
    }
    current = resolve(current, segment);
    const entry = await lstat(current);
    const isLast = index === segments.length - 1;
    if (
      entry.isSymbolicLink() ||
      (isLast ? !entry.isFile() : !entry.isDirectory())
    ) {
      return invalid("Runtime artifacts must use regular files and directories");
    }
  }
  return resolveContained(root, relativePath);
}

export async function verifyInstallDirectory(
  directory: string,
  expectedManifestSha256?: string,
): Promise<VerifiedInstallDirectory> {
  const root = resolve(directory);
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    return invalid("Runtime version root must be a regular directory");
  }
  const manifestPath = await assertRegularPath(root, installManifestFileName);
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.byteLength > maxManifestBytes) {
    return invalid("Install manifest exceeds the size limit");
  }
  const manifestSha256 = `sha256:${createHash("sha256")
    .update(manifestBytes)
    .digest("hex")}`;
  if (
    expectedManifestSha256 !== undefined &&
    (!digestPattern.test(expectedManifestSha256) ||
      manifestSha256 !== expectedManifestSha256)
  ) {
    return invalid("Install manifest digest does not match the active runtime");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    return invalid("Install manifest is not valid JSON");
  }
  const manifest = parseInstallManifest(parsed);
  let runtimePackageBytes: Buffer | undefined;
  for (const artifact of manifest.artifacts) {
    const artifactPath = await assertRegularPath(root, artifact.path);
    const bytes = await readFile(artifactPath);
    if (
      bytes.byteLength !== artifact.size ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        artifact.sha256
    ) {
      return invalid("Runtime artifact does not match the install manifest");
    }
    if (artifact.path === "package.json") {
      runtimePackageBytes = bytes;
    }
  }
  if (runtimePackageBytes === undefined) {
    return invalid("Runtime package metadata is missing");
  }
  let runtimePackage: unknown;
  try {
    runtimePackage = JSON.parse(runtimePackageBytes.toString("utf8")) as unknown;
  } catch {
    return invalid("Runtime package metadata is not valid JSON");
  }
  if (
    typeof runtimePackage !== "object" ||
    runtimePackage === null ||
    Array.isArray(runtimePackage) ||
    !exactKeys(runtimePackage as Record<string, unknown>, [
      "name",
      "version",
      "private",
      "type",
    ]) ||
    (runtimePackage as Record<string, unknown>).name !== "huaweicloud-mate" ||
    (runtimePackage as Record<string, unknown>).version !== manifest.pluginVersion ||
    (runtimePackage as Record<string, unknown>).private !== true ||
    (runtimePackage as Record<string, unknown>).type !== "module"
  ) {
    return invalid("Runtime package metadata does not match the install manifest");
  }
  return { manifest, manifestSha256 };
}
