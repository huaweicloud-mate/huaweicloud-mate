import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scanRoots = [".github", "docs", "scripts", "src", "test"];
const scanFiles = [
  ".gitignore",
  "LICENSE",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
];
const forbiddenRootFiles = ["task_plan.md", "findings.md", "progress.md"];
const textExtensions = new Set([
  ".json",
  ".jsonc",
  ".js",
  ".md",
  ".mjs",
  ".ts",
  ".yaml",
  ".yml",
]);
const maxFileBytes = 4 * 1024 * 1024;
const placeholderProfiles = new Set([
  "example",
  "fallback",
  "user",
  "username",
  "测试 user",
  "<user>",
  "{user}",
  "${user}",
]);

function sourceError(message) {
  throw new Error(`Source hygiene check failed: ${message}`);
}

async function collect(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    sourceError(`${relative(root, path)} is a symlink`);
  }
  if (entry.isFile()) return [path];
  if (!entry.isDirectory()) return [];
  const children = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const child of children.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    files.push(...await collect(resolve(path, child.name)));
  }
  return files;
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function failMatch(path, text, offset, rule) {
  sourceError(
    `${relative(root, path)}:${lineNumber(text, offset)} matches ${rule}`,
  );
}

function inspectProfiles(path, text, pattern, rule) {
  for (const match of text.matchAll(pattern)) {
    const profile = match[1]?.toLowerCase();
    if (
      profile !== undefined &&
      !placeholderProfiles.has(profile) &&
      !profile.includes("{") &&
      !profile.includes("$")
    ) {
      failMatch(path, text, match.index, rule);
    }
  }
}

function inspectText(path, text) {
  const normalized = text.replaceAll("\\\\", "\\");
  const workspace = /(?:[A-Za-z]:[\\/](?:CodeSpace|workspaces?)[\\/]|file:\/\/[A-Za-z]:\/(?:CodeSpace|workspaces?)\/)/iu.exec(
    normalized,
  );
  if (workspace !== null) {
    failMatch(path, normalized, workspace.index, "a local workspace path");
  }
  const internalEndpoint = /https?:\/\/[^\s/]+\.internal(?::\d+)?(?:\/|\s|$)/iu.exec(
    normalized,
  );
  if (internalEndpoint !== null) {
    failMatch(path, normalized, internalEndpoint.index, "an internal endpoint");
  }
  inspectProfiles(
    path,
    normalized,
    /[A-Za-z]:[\\/]Users[\\/]([^\\/\r\n]+)[\\/]/gu,
    "a non-placeholder Windows user profile",
  );
  inspectProfiles(
    path,
    normalized,
    /\/(?:Users|home)\/([^/\s]+)\//gu,
    "a non-placeholder POSIX user profile",
  );
}

for (const fileName of forbiddenRootFiles) {
  try {
    await lstat(resolve(root, fileName));
    sourceError(`${fileName} is a retired planning artifact`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const candidates = [
  ...scanFiles.map((path) => resolve(root, path)),
  ...(await Promise.all(scanRoots.map((path) => collect(resolve(root, path))))).flat(),
];
let inspected = 0;
for (const path of candidates) {
  const extension = extname(path).toLowerCase();
  if (
    !textExtensions.has(extension) &&
    !scanFiles.some((fileName) => resolve(root, fileName) === path)
  ) continue;
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size <= 0 || entry.size > maxFileBytes) {
    sourceError(`${relative(root, path)} is not a bounded regular text file`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch {
    sourceError(`${relative(root, path)} is not valid UTF-8 text`);
  }
  inspectText(path, text);
  inspected += 1;
}

console.log(`Source hygiene verified: ${inspected} text files`);
