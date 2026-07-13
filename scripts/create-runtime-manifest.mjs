import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";

const runtimeDirectory = new URL("../dist/", import.meta.url);
const companionEntryPath = "approval/companion-process.js";

const approvalModules = (await readdir(new URL("approval/", runtimeDirectory)))
  .filter((name) => name.endsWith(".js"))
  .map((name) => `approval/${name}`);
const contractSchemas = (await readdir(
  new URL("contracts/schema/", runtimeDirectory),
))
  .filter((name) => name.endsWith(".json"))
  .map((name) => `contracts/schema/${name}`);
const runtimePaths = [
  ...approvalModules,
  "contracts/manifest.js",
  "contracts/registry.js",
  ...contractSchemas,
].sort();

const artifacts = await Promise.all(
  runtimePaths.map(async (path) => ({
    path,
    sha256: `sha256:${createHash("sha256")
      .update(await readFile(new URL(path, runtimeDirectory)))
      .digest("hex")}`,
  })),
);

if (!artifacts.some((artifact) => artifact.path === companionEntryPath)) {
  throw new Error("Approval companion entry is missing from the runtime manifest");
}

const manifest = {
  schemaVersion: "huaweicloud-mate-runtime-manifest/v1",
  approvalCompanion: {
    entryPath: companionEntryPath,
    artifacts,
  },
};

await writeFile(
  new URL("runtime-manifest.json", runtimeDirectory),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
