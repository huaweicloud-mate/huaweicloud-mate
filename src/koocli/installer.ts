import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { HostCommandRunner } from "../hosts/command-runner.js";
import { InstallerError } from "../installer/errors.js";
import {
  type KooCliArtifactBinding,
  currentKooCliPlatform,
  validateKooCliArtifactBinding,
} from "./artifacts.js";
import { extractKooCliTarGz, extractKooCliZip } from "./archive.js";
import { inspectKooCliExecutable } from "./discovery.js";

const maxArchiveBytes = 128 * 1024 * 1024;
const maxInstallRecordBytes = 16 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

interface KooCliInstallRecord {
  readonly schemaVersion: 1;
  readonly platform: KooCliArtifactBinding["platform"];
  readonly version: string;
  readonly archive: KooCliArtifactBinding["archive"];
  readonly url: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
}

export interface KooCliArtifactFetcher {
  fetch(url: string): Promise<Uint8Array>;
}

export interface KooCliInstallOptions {
  readonly runtimeRoot: string;
  readonly artifact: KooCliArtifactBinding;
  readonly runner: HostCommandRunner;
  readonly fetcher?: KooCliArtifactFetcher;
}

export interface InstalledPrivateKooCli {
  readonly status: "installed" | "reused";
  readonly version: string;
  readonly executablePath: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
}

interface PrivateInstallPaths {
  readonly parent: string;
  readonly target: string;
  readonly executablePath: string;
  readonly recordPath: string;
}

function invalid(message: string): never {
  throw new InstallerError("KOOCLI_INSTALL_INVALID", message);
}

function conflict(message: string): never {
  throw new InstallerError("KOOCLI_INSTALL_CONFLICT", message);
}

function failed(message: string): never {
  throw new InstallerError("KOOCLI_INSTALL_FAILED", message);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

async function commitStagingDirectory(
  staging: string,
  target: string,
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(staging, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        return conflict("Private KooCLI installation appeared during commit");
      }
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EBUSY") &&
        attempt < 5
      ) {
        await delay(25 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

class HttpsArtifactFetcher implements KooCliArtifactFetcher {
  async fetch(url: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "error" });
    } catch {
      return failed("KooCLI artifact download failed");
    }
    if (!response.ok || response.body === null) {
      return failed("KooCLI artifact server returned an unsuccessful response");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^[0-9]+$/u.test(declaredLength) ||
        Number(declaredLength) > maxArchiveBytes)
    ) {
      return failed("KooCLI artifact exceeds the download limit");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxArchiveBytes) {
        await reader.cancel();
        return failed("KooCLI artifact exceeds the download limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

async function regularDirectory(path: string, description: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return invalid(`${description} is not a regular directory`);
  }
}

async function ensureDirectoryChain(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  if (suffix === "" || suffix.startsWith("..") || isAbsolute(suffix)) {
    return invalid("KooCLI private install path escapes the runtime root");
  }
  let current = root;
  for (const part of suffix.split(/[\\/]/u)) {
    current = resolve(current, part);
    try {
      await regularDirectory(current, "KooCLI install directory");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
      await regularDirectory(current, "KooCLI install directory");
    }
  }
}

async function readRegularFile(path: string): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256 * 1024 * 1024) {
    return invalid("KooCLI executable is not a bounded regular file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size) {
    return conflict("KooCLI executable changed while it was read");
  }
  return bytes;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function parseInstallRecord(value: unknown): KooCliInstallRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "platform",
      "version",
      "archive",
      "url",
      "archiveSha256",
      "executableSha256",
    ])
  ) {
    return invalid("Private KooCLI install record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.platform !== "string" ||
    typeof record.version !== "string" ||
    (record.archive !== "zip" && record.archive !== "tar.gz") ||
    typeof record.url !== "string" ||
    typeof record.archiveSha256 !== "string" ||
    !digestPattern.test(record.archiveSha256) ||
    typeof record.executableSha256 !== "string" ||
    !digestPattern.test(record.executableSha256)
  ) {
    return invalid("Private KooCLI install record fields are invalid");
  }
  const binding = validateKooCliArtifactBinding({
    platform: record.platform as KooCliArtifactBinding["platform"],
    version: record.version as KooCliArtifactBinding["version"],
    archive: record.archive,
    url: record.url,
    sha256: record.archiveSha256,
  });
  return {
    schemaVersion: 1,
    platform: binding.platform,
    version: binding.version,
    archive: binding.archive,
    url: binding.url,
    archiveSha256: binding.sha256,
    executableSha256: record.executableSha256,
  };
}

async function readInstallRecord(path: string): Promise<KooCliInstallRecord> {
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size === 0 ||
    entry.size > maxInstallRecordBytes
  ) {
    return invalid("Private KooCLI install record is not a bounded regular file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size) {
    return conflict("Private KooCLI install record changed while it was read");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("Private KooCLI install record is not valid UTF-8 JSON");
  }
  return parseInstallRecord(value);
}

async function verifyExecutable(
  executablePath: string,
  expectedVersion: string,
  runner: HostCommandRunner,
  expectedSha256?: string,
): Promise<string> {
  const bytes = await readRegularFile(executablePath);
  const executableSha256 = digest(bytes);
  if (expectedSha256 !== undefined && executableSha256 !== expectedSha256) {
    return conflict("Private KooCLI executable changed after installation");
  }
  const report = await inspectKooCliExecutable(executablePath, runner);
  if (
    report.status !== "compatible" ||
    report.version !== expectedVersion ||
    report.executablePath !== executablePath
  ) {
    return conflict("Private KooCLI executable failed its fixed version check");
  }
  return executableSha256;
}

function privateInstallPaths(
  runtimeRoot: string,
  artifact: KooCliArtifactBinding,
): PrivateInstallPaths {
  const parent = resolve(runtimeRoot, "tools", "koocli", artifact.version);
  const target = resolve(parent, artifact.platform);
  const executablePath = resolve(
    target,
    artifact.platform === "windows-amd64" ? "hcloud.exe" : "hcloud",
  );
  return {
    parent,
    target,
    executablePath,
    recordPath: resolve(target, "installation.json"),
  };
}

export async function inspectPrivateKooCli(
  runtimeRootInput: string,
  artifactInput: KooCliArtifactBinding,
  runner: HostCommandRunner,
): Promise<InstalledPrivateKooCli | undefined> {
  if (!isAbsolute(runtimeRootInput)) {
    return invalid("KooCLI runtime root must be absolute");
  }
  const artifact = validateKooCliArtifactBinding(artifactInput);
  if (artifact.platform !== currentKooCliPlatform()) {
    return invalid("KooCLI artifact does not match the current platform");
  }
  const runtimeRoot = resolve(runtimeRootInput);
  try {
    await regularDirectory(runtimeRoot, "Runtime root");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const paths = privateInstallPaths(runtimeRoot, artifact);
  try {
    await regularDirectory(paths.target, "Private KooCLI installation");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const record = await readInstallRecord(paths.recordPath);
  if (
    record.platform !== artifact.platform ||
    record.version !== artifact.version ||
    record.archive !== artifact.archive ||
    record.url !== artifact.url ||
    record.archiveSha256 !== artifact.sha256
  ) {
    return conflict("Private KooCLI installation does not match its binding");
  }
  return {
    status: "reused",
    version: artifact.version,
    executablePath: paths.executablePath,
    archiveSha256: artifact.sha256,
    executableSha256: await verifyExecutable(
      paths.executablePath,
      artifact.version,
      runner,
      record.executableSha256,
    ),
  };
}

export async function installPrivateKooCli(
  options: KooCliInstallOptions,
): Promise<InstalledPrivateKooCli> {
  if (!isAbsolute(options.runtimeRoot)) {
    return invalid("KooCLI runtime root must be absolute");
  }
  const artifact = validateKooCliArtifactBinding(options.artifact);
  if (artifact.platform !== currentKooCliPlatform()) {
    return invalid("KooCLI artifact does not match the current platform");
  }
  const runtimeRoot = resolve(options.runtimeRoot);
  await regularDirectory(runtimeRoot, "Runtime root");
  const { parent, target, executablePath } = privateInstallPaths(
    runtimeRoot,
    artifact,
  );
  await ensureDirectoryChain(runtimeRoot, parent);
  const existing = await inspectPrivateKooCli(
    runtimeRoot,
    artifact,
    options.runner,
  );
  if (existing !== undefined) {
    return existing;
  }

  let archive: Uint8Array;
  try {
    archive = await (options.fetcher ?? new HttpsArtifactFetcher()).fetch(
      artifact.url,
    );
  } catch {
    return failed("KooCLI artifact download failed");
  }
  if (archive.byteLength === 0 || archive.byteLength > maxArchiveBytes) {
    return failed("KooCLI artifact is empty or oversized");
  }
  if (digest(archive) !== artifact.sha256) {
    return conflict("KooCLI artifact SHA-256 does not match its binding");
  }
  const executable = artifact.archive === "zip"
    ? extractKooCliZip(archive)
    : extractKooCliTarGz(archive);
  const staging = resolve(
    parent,
    `.${basename(target)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let failureStage = "staging-create";
  try {
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    failureStage = "executable-write";
    const stagedExecutable = resolve(staging, basename(executablePath));
    const handle = await open(stagedExecutable, "wx", 0o700);
    try {
      await handle.writeFile(executable);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(stagedExecutable, 0o700);
    failureStage = "executable-verify";
    const executableSha256 = await verifyExecutable(
      stagedExecutable,
      artifact.version,
      options.runner,
    );
    const record: KooCliInstallRecord = {
      schemaVersion: 1,
      platform: artifact.platform,
      version: artifact.version,
      archive: artifact.archive,
      url: artifact.url,
      archiveSha256: artifact.sha256,
      executableSha256,
    };
    failureStage = "record-write";
    const recordHandle = await open(resolve(staging, "installation.json"), "wx", 0o600);
    try {
      await recordHandle.writeFile(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
      );
      await recordHandle.sync();
    } finally {
      await recordHandle.close();
    }
    failureStage = "atomic-commit";
    await commitStagingDirectory(staging, target);
    return {
      status: "installed",
      version: artifact.version,
      executablePath,
      archiveSha256: artifact.sha256,
      executableSha256,
    };
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "KOOCLI_INSTALL_FAILED",
      `Private KooCLI installation failed during ${failureStage}`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
