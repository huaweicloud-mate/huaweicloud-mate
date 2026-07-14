import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const versionedArtifacts = [
  "cli.js",
  "host-assets/claude/plugin/.claude-plugin/plugin.json",
  "host-assets/codex/plugin/.codex-plugin/plugin.json",
  "mcp/server.js",
  "package.json",
  "runtime/cli.js",
] as const;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function copyRuntimeCandidate(
  sourceDirectory: string,
  targetDirectory: string,
  pluginVersion: string,
): Promise<void> {
  await cp(sourceDirectory, targetDirectory, { recursive: true });
  const manifestPath = resolve(targetDirectory, "install-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    pluginVersion: string;
    artifacts: Array<{ path: string; size: number; sha256: string }>;
  };
  const previousVersion = manifest.pluginVersion;
  manifest.pluginVersion = pluginVersion;

  for (const artifactPath of versionedArtifacts) {
    const path = resolve(targetDirectory, ...artifactPath.split("/"));
    const original = await readFile(path, "utf8");
    if (!original.includes(previousVersion)) {
      throw new Error(`Candidate artifact does not contain ${previousVersion}: ${artifactPath}`);
    }
    const bytes = Buffer.from(
      original.replaceAll(previousVersion, pluginVersion),
      "utf8",
    );
    await writeFile(path, bytes);
    const artifact = manifest.artifacts.find(
      (candidate) => candidate.path === artifactPath,
    );
    if (artifact === undefined) {
      throw new Error(`Candidate manifest is missing ${artifactPath}`);
    }
    artifact.size = bytes.byteLength;
    artifact.sha256 = digest(bytes);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
