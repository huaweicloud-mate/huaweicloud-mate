import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { InstallerError } from "./errors.js";
import {
  installManifestFileName,
  stableLauncherArtifactPath,
  verifyInstallDirectory,
} from "./install-manifest.js";
import { defaultRuntimeRoot } from "./paths.js";

const stableLauncherFileName = "hcloud-agent.mjs";
const activeRuntimeFileName = "active-runtime.json";

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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
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

export async function materializeStableRuntime(
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
  const activeRuntimePath = resolve(currentDirectory, activeRuntimeFileName);
  const activeRuntime = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: "huaweicloud-mate-active-runtime/v1",
        pluginVersion: source.manifest.pluginVersion,
        installManifestSha256: source.manifestSha256,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    await atomicWriteFile(activeRuntimePath, activeRuntime, 0o600);
  } catch {
    throw new InstallerError(
      "RUNTIME_ACTIVATION_FAILED",
      "Verified runtime could not be activated",
    );
  }

  return {
    pluginVersion: source.manifest.pluginVersion,
    installManifestSha256: source.manifestSha256,
    runtimeRoot,
    versionDirectory,
    stableLauncherPath,
    activeRuntimePath,
    nodePath: process.execPath,
    reusedVersion,
  };
}
