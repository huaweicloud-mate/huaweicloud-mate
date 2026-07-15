import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const { releasedKooCliArtifacts } = await import(
  new URL("dist/koocli/release-artifacts.js", root)
);
const {
  pinnedPrivateKooCliVersion,
  validateKooCliArtifactBinding,
} = await import(new URL("dist/koocli/artifacts.js", root));
const { pluginVersion } = await import(new URL("dist/version.js", root));
if (pluginVersion !== packageJson.version) {
  throw new Error(
    "Runtime version does not match package.json; update the single source version binding",
  );
}
const validatedKooCliArtifacts = Array.isArray(releasedKooCliArtifacts)
  ? releasedKooCliArtifacts.map((artifact) =>
      validateKooCliArtifactBinding(artifact)
    )
  : [];
const platforms = new Set(
  validatedKooCliArtifacts.map((artifact) => artifact.platform),
);
const requiredPlatforms = [
  "windows-amd64",
  "linux-amd64",
  "linux-arm64",
  "mac-amd64",
  "mac-arm64",
];
if (
  validatedKooCliArtifacts.length !== requiredPlatforms.length ||
  platforms.size !== requiredPlatforms.length ||
  requiredPlatforms.some((platform) => !platforms.has(platform)) ||
  validatedKooCliArtifacts.some(
    (artifact) => artifact.version !== pinnedPrivateKooCliVersion,
  )
) {
  throw new Error(
    "Release requires one approved digest-pinned KooCLI artifact binding for every supported platform",
  );
}

if (
  packageJson.private !== false ||
  packageJson.name !== "huaweicloud-mate" ||
  typeof packageJson.version !== "string" ||
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version) ||
  packageJson.version.includes("development") ||
  packageJson.publishConfig?.access !== "public" ||
  packageJson.publishConfig?.provenance !== true
) {
  throw new Error(
    "Package identity is not release-ready; bind the approved npm identity and non-development version",
  );
}

console.log(
  `Release readiness verified for ${packageJson.name}@${packageJson.version}`,
);
