#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const activeRuntimeFileName = "active-runtime.json";
const installManifestFileName = "install-manifest.json";
const safeVersionPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const safeArtifactPathPattern =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const maxPointerBytes = 65_536;
const maxManifestBytes = 8 * 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxRuntimeBytes = 512 * 1024 * 1024;
const maxArtifactCount = 4096;
const runtimeImportMetaUrlKey =
  "__HUAWEICLOUD_MATE_RUNTIME_IMPORT_META_URL__";

interface ActiveRuntime {
  readonly schemaVersion: "huaweicloud-mate-active-runtime/v1";
  readonly pluginVersion: string;
  readonly installManifestSha256: string;
}

interface RuntimeArtifact {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function fail(): never {
  throw new Error("Stable runtime verification failed");
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) {
    return fail();
  }
  return readFile(path);
}

function parseActiveRuntime(value: unknown): ActiveRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "schemaVersion",
      "pluginVersion",
      "installManifestSha256",
    ]) ||
    record.schemaVersion !== "huaweicloud-mate-active-runtime/v1" ||
    typeof record.pluginVersion !== "string" ||
    !safeVersionPattern.test(record.pluginVersion) ||
    typeof record.installManifestSha256 !== "string" ||
    !digestPattern.test(record.installManifestSha256)
  ) {
    return fail();
  }
  return {
    schemaVersion: "huaweicloud-mate-active-runtime/v1",
    pluginVersion: record.pluginVersion,
    installManifestSha256: record.installManifestSha256,
  };
}

function parseRuntimeArtifacts(
  value: unknown,
  expectedVersion: string,
): readonly RuntimeArtifact[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
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
    record.pluginVersion !== expectedVersion ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length === 0 ||
    record.artifacts.length > maxArtifactCount
  ) {
    return fail();
  }

  let previousPath = "";
  let totalBytes = 0;
  const seen = new Set<string>();
  const artifacts = record.artifacts.map((value): RuntimeArtifact => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail();
    }
    const artifact = value as Record<string, unknown>;
    if (
      !exactKeys(artifact, ["path", "size", "sha256"]) ||
      typeof artifact.path !== "string" ||
      !safeArtifactPathPattern.test(artifact.path) ||
      artifact.path.split("/").some((part) => part === "." || part === "..") ||
      artifact.path === installManifestFileName ||
      artifact.path <= previousPath ||
      seen.has(artifact.path) ||
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > maxArtifactBytes ||
      typeof artifact.sha256 !== "string" ||
      !digestPattern.test(artifact.sha256)
    ) {
      return fail();
    }
    previousPath = artifact.path;
    seen.add(artifact.path);
    totalBytes += artifact.size;
    if (totalBytes > maxRuntimeBytes) {
      return fail();
    }
    return {
      path: artifact.path,
      size: artifact.size,
      sha256: artifact.sha256,
    };
  });
  if (
    !seen.has("installer/stable-launcher.js") ||
    !seen.has("package.json") ||
    !seen.has("runtime/cli.js") ||
    !seen.has("runtime-manifest.json")
  ) {
    return fail();
  }
  return artifacts;
}

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

async function verifyArtifact(
  runtimeDirectory: string,
  artifact: RuntimeArtifact,
): Promise<Buffer> {
  let current = runtimeDirectory;
  const segments = artifact.path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return fail();
    }
    current = resolve(current, segment);
    if (!contained(runtimeDirectory, current)) {
      return fail();
    }
    const entry = await lstat(current);
    const isLast = index === segments.length - 1;
    if (
      entry.isSymbolicLink() ||
      (isLast ? !entry.isFile() : !entry.isDirectory())
    ) {
      return fail();
    }
  }
  const bytes = await readRegularFile(current, maxArtifactBytes);
  if (bytes.byteLength !== artifact.size || digest(bytes) !== artifact.sha256) {
    return fail();
  }
  return bytes;
}

async function verifiedCli(
  launcherUrl: string,
): Promise<{ readonly url: URL; readonly bytes: Buffer }> {
  const currentDirectory = dirname(fileURLToPath(launcherUrl));
  const runtimeRoot = dirname(currentDirectory);
  const currentEntry = await lstat(currentDirectory);
  if (!currentEntry.isDirectory() || currentEntry.isSymbolicLink()) {
    return fail();
  }
  const pointerBytes = await readRegularFile(
    resolve(currentDirectory, activeRuntimeFileName),
    maxPointerBytes,
  );
  let pointerValue: unknown;
  try {
    pointerValue = JSON.parse(pointerBytes.toString("utf8")) as unknown;
  } catch {
    return fail();
  }
  const pointer = parseActiveRuntime(pointerValue);
  const runtimeDirectory = resolve(
    runtimeRoot,
    "versions",
    pointer.pluginVersion,
  );
  if (!contained(resolve(runtimeRoot, "versions"), runtimeDirectory)) {
    return fail();
  }
  const runtimeEntry = await lstat(runtimeDirectory);
  if (!runtimeEntry.isDirectory() || runtimeEntry.isSymbolicLink()) {
    return fail();
  }
  const manifestBytes = await readRegularFile(
    resolve(runtimeDirectory, installManifestFileName),
    maxManifestBytes,
  );
  if (digest(manifestBytes) !== pointer.installManifestSha256) {
    return fail();
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    return fail();
  }
  const artifacts = parseRuntimeArtifacts(
    manifestValue,
    pointer.pluginVersion,
  );
  let runtimePackageBytes: Buffer | undefined;
  let runtimeCliBytes: Buffer | undefined;
  for (const artifact of artifacts) {
    const artifactBytes = await verifyArtifact(runtimeDirectory, artifact);
    if (artifact.path === "package.json") {
      runtimePackageBytes = artifactBytes;
    }
    if (artifact.path === "runtime/cli.js") {
      runtimeCliBytes = artifactBytes;
    }
  }
  if (runtimePackageBytes === undefined || runtimeCliBytes === undefined) {
    return fail();
  }
  let runtimePackage: unknown;
  try {
    runtimePackage = JSON.parse(runtimePackageBytes.toString("utf8")) as unknown;
  } catch {
    return fail();
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
    (runtimePackage as Record<string, unknown>).version !==
      pointer.pluginVersion ||
    (runtimePackage as Record<string, unknown>).private !== true ||
    (runtimePackage as Record<string, unknown>).type !== "module"
  ) {
    return fail();
  }
  return {
    url: pathToFileURL(resolve(runtimeDirectory, "runtime", "cli.js")),
    bytes: runtimeCliBytes,
  };
}

function bindRuntimeImportMetaUrl(url: string): void {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  if (Object.hasOwn(target, runtimeImportMetaUrlKey)) {
    if (target[runtimeImportMetaUrlKey] !== url) {
      return fail();
    }
    return;
  }
  Object.defineProperty(target, runtimeImportMetaUrlKey, {
    value: url,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export async function runStableLauncher(
  args: readonly string[],
  launcherUrl = import.meta.url,
): Promise<number> {
  const cliRuntime = await verifiedCli(launcherUrl);
  bindRuntimeImportMetaUrl(cliRuntime.url.href);
  const verifiedModuleUrl = `data:text/javascript;base64,${cliRuntime.bytes.toString("base64")}`;
  const cli = (await import(verifiedModuleUrl)) as {
    readonly main?: (args: readonly string[]) => Promise<number>;
  };
  if (typeof cli.main !== "function") {
    return fail();
  }
  return cli.main(args);
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    process.exitCode = await runStableLauncher(process.argv.slice(2));
  } catch {
    console.error("huaweicloud-mate stable runtime verification failed");
    process.exitCode = 1;
  }
}
