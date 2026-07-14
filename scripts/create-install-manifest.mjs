import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";

const runtimeDirectory = new URL("../dist/", import.meta.url);
const manifestName = "install-manifest.json";

async function collectFiles(directory, prefix = "") {
  const names = await readdir(directory);
  const files = [];
  for (const name of names.sort()) {
    const relativePath = prefix === "" ? name : `${prefix}/${name}`;
    if (relativePath === manifestName) {
      continue;
    }
    const url = new URL(relativePath, runtimeDirectory);
    const entry = await lstat(url);
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime build output cannot contain symlinks: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(url, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Runtime build output must contain regular files: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files;
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  packageJson.name !== "huaweicloud-mate" ||
  typeof packageJson.version !== "string"
) {
  throw new Error("Package identity is invalid for the install manifest");
}

await writeFile(
  new URL("package.json", runtimeDirectory),
  `${JSON.stringify(
    {
      name: packageJson.name,
      version: packageJson.version,
      private: true,
      type: "module",
    },
    null,
    2,
  )}\n`,
);

const requiredPaths = [
  "cli.js",
  "installer/stable-launcher.js",
  "package.json",
  "runtime/cli.js",
  "runtime-manifest.json",
];
const runtimePaths = (await collectFiles(runtimeDirectory)).sort();
for (const requiredPath of requiredPaths) {
  if (!runtimePaths.includes(requiredPath)) {
    throw new Error(`Required runtime artifact is missing: ${requiredPath}`);
  }
}

const artifacts = await Promise.all(
  runtimePaths.map(async (path) => {
    const bytes = await readFile(new URL(path, runtimeDirectory));
    return {
      path,
      size: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }),
);

await writeFile(
  new URL(manifestName, runtimeDirectory),
  `${JSON.stringify(
    {
      schemaVersion: "huaweicloud-mate-install-manifest/v1",
      packageName: packageJson.name,
      pluginVersion: packageJson.version,
      artifacts,
    },
    null,
    2,
  )}\n`,
);
