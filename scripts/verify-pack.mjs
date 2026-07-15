import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || npmCli === "") {
  throw new Error("npm CLI path is unavailable");
}
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function runNpm(arguments_, cwd) {
  return spawnSync(process.execPath, [npmCli, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
}

function requireSuccess(result, operation) {
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`,
    );
  }
}

function parseSinglePackReport(stdout, operation) {
  let reports;
  try {
    reports = JSON.parse(stdout);
  } catch {
    throw new Error(`${operation} did not return JSON`);
  }
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error(`${operation} must produce exactly one package`);
  }
  return reports[0];
}

const result = runNpm(
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  projectRoot,
);
if (result.status !== 0) {
  throw new Error(
    `npm pack --dry-run failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`,
  );
}

const report = parseSinglePackReport(result.stdout, "npm pack --dry-run");
if (
  typeof report !== "object" ||
  report === null ||
  !Array.isArray(report.files) ||
  !Number.isSafeInteger(report.size) ||
  !Number.isSafeInteger(report.unpackedSize) ||
  report.size > 5 * 1024 * 1024 ||
  report.unpackedSize > 15 * 1024 * 1024 ||
  report.files.length > 400
) {
  throw new Error("npm package exceeds its size or entry-count budget");
}

const paths = new Set();
for (const file of report.files) {
  if (
    typeof file !== "object" ||
    file === null ||
    typeof file.path !== "string" ||
    file.path.includes("\\") ||
    file.path.startsWith("/") ||
    file.path.split("/").includes("..") ||
    (!file.path.startsWith("dist/") &&
      file.path !== "LICENSE" &&
      file.path !== "README.md" &&
      file.path !== "package.json") ||
    file.path.endsWith(".map") ||
    file.path.endsWith(".ts") ||
    file.path.includes("credentials") && !file.path.startsWith("dist/auth/")
  ) {
    throw new Error(`Unexpected npm package entry: ${String(file.path)}`);
  }
  if (paths.has(file.path)) {
    throw new Error(`Duplicate npm package entry: ${file.path}`);
  }
  paths.add(file.path);
}

for (const required of [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/cli.js",
  "dist/install-manifest.json",
  "dist/runtime-manifest.json",
  "dist/runtime/cli.js",
  "dist/contracts/schema/router-tools-v1-lite.schema.json",
  "dist/host-assets/codex/plugin/.codex-plugin/plugin.json",
  "dist/host-assets/claude/plugin/.claude-plugin/plugin.json",
]) {
  if (!paths.has(required)) {
    throw new Error(`Required npm package entry is missing: ${required}`);
  }
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "huaweicloud-mate-pack-"));
try {
  const packed = runNpm(
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryRoot,
    ],
    projectRoot,
  );
  requireSuccess(packed, "npm pack");
  const packedReport = parseSinglePackReport(packed.stdout, "npm pack");
  if (
    typeof packedReport.filename !== "string" ||
    packedReport.filename === "" ||
    packedReport.size !== report.size ||
    packedReport.unpackedSize !== report.unpackedSize
  ) {
    throw new Error("Real npm package does not match the verified dry-run report");
  }

  const tarballPath = resolve(temporaryRoot, packedReport.filename);
  const relativeTarballPath = relative(temporaryRoot, tarballPath);
  if (
    relativeTarballPath === "" ||
    isAbsolute(relativeTarballPath) ||
    relativeTarballPath === ".." ||
    relativeTarballPath.startsWith(`..${sep}`)
  ) {
    throw new Error("npm pack returned a tarball outside the temporary directory");
  }
  const consumerRoot = join(temporaryRoot, "consumer");
  const installed = runNpm(
    [
      "install",
      "--prefix",
      consumerRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=false",
      "--offline",
      tarballPath,
    ],
    temporaryRoot,
  );
  requireSuccess(installed, "isolated offline npm install");

  const installedPackageRoot = join(
    consumerRoot,
    "node_modules",
    packageJson.name,
  );
  const installedPackage = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );
  if (
    installedPackage.name !== packageJson.name ||
    installedPackage.version !== packageJson.version ||
    installedPackage.bin?.[packageJson.name] !== "dist/cli.js"
  ) {
    throw new Error("Installed package identity or bin binding is invalid");
  }

  const binPath = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${packageJson.name}.cmd` : packageJson.name,
  );
  const binStat = await lstat(binPath);
  if (!(binStat.isFile() || binStat.isSymbolicLink())) {
    throw new Error("Installed npm bin shim is not a file or symbolic link");
  }

  const npmExecPrefix = [
    "exec",
    "--prefix",
    consumerRoot,
    "--offline",
    "--yes=false",
    "--",
    packageJson.name,
  ];
  const versionResult = runNpm(
    [...npmExecPrefix, "version"],
    temporaryRoot,
  );
  requireSuccess(versionResult, "installed package version command");
  if (versionResult.stdout.trim() !== packageJson.version) {
    throw new Error("Installed package version output does not match package.json");
  }

  const doctorResult = runNpm(
    [...npmExecPrefix, "doctor", "--contracts-only", "--json"],
    temporaryRoot,
  );
  requireSuccess(doctorResult, "installed package contract doctor");
  let doctorReport;
  try {
    doctorReport = JSON.parse(doctorResult.stdout);
  } catch {
    throw new Error("Installed package contract doctor did not return JSON");
  }
  if (
    doctorReport?.ok !== true ||
    !Number.isSafeInteger(doctorReport.schemaCount) ||
    doctorReport.schemaCount < 1 ||
    !Number.isSafeInteger(doctorReport.vectorCount) ||
    doctorReport.vectorCount < 1 ||
    !Number.isSafeInteger(doctorReport.stateMachineVectorCount) ||
    doctorReport.stateMachineVectorCount < 1 ||
    doctorReport.deferredStateMachineVectorCount !== 0
  ) {
    throw new Error("Installed package contract doctor did not prove a complete local contract pass");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `npm package verified and smoke-tested: ${report.files.length} entries, ${report.size} packed bytes`,
);
