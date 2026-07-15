import { mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const distDirectory = new URL("../dist/", import.meta.url);
const runtimeDirectory = new URL("runtime/", distDirectory);
await mkdir(runtimeDirectory, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  minify: false,
  treeShaking: true,
  mainFields: ["module", "main"],
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [fileURLToPath(new URL("cli.js", distDirectory))],
  outfile: fileURLToPath(new URL("cli.js", runtimeDirectory)),
  define: {
    "import.meta.url":
      "globalThis.__HUAWEICLOUD_MATE_RUNTIME_IMPORT_META_URL__",
  },
  banner: {
    js: "globalThis.__HUAWEICLOUD_MATE_RUNTIME_IMPORT_META_URL__ ??= import.meta.url;",
  },
});

const companionBundle = new URL(
  "approval/.companion-process.bundle.js",
  distDirectory,
);
await build({
  ...common,
  entryPoints: [
    fileURLToPath(new URL("approval/companion-process.js", distDirectory)),
  ],
  outfile: fileURLToPath(companionBundle),
  define: {
    "import.meta.url":
      "globalThis.__HUAWEICLOUD_MATE_COMPANION_IMPORT_META_URL__",
  },
  banner: {
    js: "globalThis.__HUAWEICLOUD_MATE_COMPANION_IMPORT_META_URL__ ??= import.meta.url;",
  },
});
await rename(
  companionBundle,
  new URL("approval/companion-process.js", distDirectory),
);
