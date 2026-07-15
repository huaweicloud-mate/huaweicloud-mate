const { existsSync, rmSync } = require("node:fs");
const { resolve, sep } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const outputDirectory = resolve(projectRoot, "build");

if (!outputDirectory.startsWith(`${projectRoot}${sep}`)) throw new Error("Refusing to remove a build directory outside the project.");
if (existsSync(outputDirectory)) rmSync(outputDirectory, { recursive: true, force: true });
