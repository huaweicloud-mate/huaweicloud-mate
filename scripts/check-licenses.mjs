import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", projectRoot), "utf8"),
);
if (
  typeof lock !== "object" ||
  lock === null ||
  typeof lock.packages !== "object" ||
  lock.packages === null
) {
  throw new Error("package-lock.json does not contain a packages map");
}

const forbidden = /(?:^|[^A-Za-z])(?:AGPL|GPL-[123]|SSPL|BUSL|UNLICENSED)(?:$|[^A-Za-z0-9])/iu;
const checked = [];
for (const [path, lockEntry] of Object.entries(lock.packages)) {
  if (
    path === "" ||
    typeof lockEntry !== "object" ||
    lockEntry === null ||
    lockEntry.dev === true ||
    lockEntry.link === true
  ) {
    continue;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(
      await readFile(new URL(`${path.replaceAll("\\", "/")}/package.json`, projectRoot), "utf8"),
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT" &&
      lockEntry.optional === true
    ) {
      continue;
    }
    throw error;
  }
  if (
    typeof packageJson.name !== "string" ||
    typeof packageJson.version !== "string" ||
    typeof packageJson.license !== "string" ||
    packageJson.license.trim() === "" ||
    forbidden.test(packageJson.license)
  ) {
    throw new Error(`Production dependency has an unacceptable license: ${path}`);
  }
  checked.push(`${packageJson.name}@${packageJson.version} (${packageJson.license})`);
}

checked.sort();
console.log(`Production dependency licenses verified: ${checked.length}`);
for (const dependency of checked) console.log(`- ${dependency}`);
