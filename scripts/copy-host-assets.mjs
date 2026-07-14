import { cp, mkdir, readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const templatesSource = new URL("../src/hosts/templates/", import.meta.url);
const templatesTarget = new URL("../dist/hosts/templates/", import.meta.url);
const canonicalSource = new URL(
  "../skills/canonical/huaweicloud/",
  import.meta.url,
);
const canonicalTarget = new URL(
  "../dist/skills/canonical/huaweicloud/",
  import.meta.url,
);

await mkdir(templatesTarget, { recursive: true });
await cp(templatesSource, templatesTarget, { recursive: true, force: false });
await mkdir(canonicalTarget, { recursive: true });
await cp(canonicalSource, canonicalTarget, { recursive: true, force: false });

for (const hostId of ["codex", "claude"]) {
  const source = new URL(`../assets/hosts/${hostId}/plugin/`, import.meta.url);
  const target = new URL(`../dist/host-assets/${hostId}/plugin/`, import.meta.url);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: false });
  await cp(canonicalSource, new URL("skills/huaweicloud/", target), {
    recursive: true,
    force: false,
  });

  const manifestName = hostId === "codex"
    ? ".codex-plugin/plugin.json"
    : ".claude-plugin/plugin.json";
  const manifest = JSON.parse(await readFile(new URL(manifestName, target), "utf8"));
  if (
    manifest.name !== packageJson.name ||
    manifest.version !== packageJson.version
  ) {
    throw new Error(`${hostId} plugin identity does not match package.json`);
  }
}
