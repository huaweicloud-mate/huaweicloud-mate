import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeHostAssets,
  rollbackHostAssetChange,
  verifyHostAssetChange,
} from "../../src/installer/host-assets.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import type { HostId } from "../../src/hosts/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-assets-"));
  temporaryRoots.push(root);
  return root;
}

async function fixture(id: HostId) {
  const root = await temporaryRoot();
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const plan = createHostInstallPlan(
    registry.get(id),
    runtime,
    platform,
    resolve(root, "home"),
  );
  return { root, runtime, plan };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("host asset materialization", () => {
  it("renders, validates, and atomically materializes a Codex plugin", async () => {
    const { runtime, plan } = await fixture("codex");
    const change = await materializeHostAssets(plan, runtime);
    const mcp = JSON.parse(
      await readFile(resolve(change.targetPath, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: {
        "huaweicloud-agent": { command: string; args: string[] };
      };
    };

    expect(change).toMatchObject({
      hostId: "codex",
      kind: "plugin",
      changed: true,
    });
    expect(change.installedTreeHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(mcp.mcpServers["huaweicloud-agent"]).toEqual({
      command: process.execPath,
      args: [runtime.stableLauncherPath, "router", "--stdio"],
    });
    expect(JSON.stringify(mcp)).not.toContain("{stableLauncherPath}");
    expect(
      await readFile(
        resolve(change.targetPath, "skills", "huaweicloud", "SKILL.md"),
        "utf8",
      ),
    ).toBe(
      await readFile(
        resolve(plan.pluginSourcePath as string, "skills", "huaweicloud", "SKILL.md"),
        "utf8",
      ),
    );

    const repeated = await materializeHostAssets(plan, runtime);
    expect(repeated).toMatchObject({
      changed: false,
      installedTreeHash: change.installedTreeHash,
    });

    await rollbackHostAssetChange(change);
    expect(await pathExists(change.targetPath)).toBe(false);
    expect(await pathExists(resolve(runtime.runtimeRoot, "hosts"))).toBe(false);
  });

  it("materializes the canonical Skill for a config-based host", async () => {
    const { runtime, plan } = await fixture("codearts");
    const change = await materializeHostAssets(plan, runtime);

    expect(change).toMatchObject({
      hostId: "codearts",
      kind: "skill",
      targetPath: plan.skillTargetPath,
      changed: true,
    });
    expect(await readFile(resolve(change.targetPath, "SKILL.md"), "utf8")).toBe(
      await readFile(resolve(plan.skillSourcePath, "SKILL.md"), "utf8"),
    );

    await rollbackHostAssetChange(change);
    expect(await pathExists(change.targetPath)).toBe(false);
  });

  it("rejects different target content and preserves user changes", async () => {
    const { runtime, plan } = await fixture("opencode");
    const change = await materializeHostAssets(plan, runtime);
    const skillPath = resolve(change.targetPath, "SKILL.md");
    const modified = `${await readFile(skillPath, "utf8")}\nuser change\n`;
    await writeFile(skillPath, modified, "utf8");

    await expect(materializeHostAssets(plan, runtime)).rejects.toMatchObject({
      code: "HOST_ASSET_CONFLICT",
    });
    await expect(verifyHostAssetChange(change)).rejects.toMatchObject({
      code: "HOST_ASSET_CONFLICT",
    });
    await expect(rollbackHostAssetChange(change)).rejects.toMatchObject({
      code: "HOST_ASSET_ROLLBACK_CONFLICT",
    });
    expect(await readFile(skillPath, "utf8")).toBe(modified);
  });

  it("rejects a runtime asset changed after activation", async () => {
    const { runtime, plan } = await fixture("codearts");
    await writeFile(
      resolve(runtime.versionDirectory, "skills", "canonical", "huaweicloud", "SKILL.md"),
      "tampered\n",
      "utf8",
    );

    await expect(materializeHostAssets(plan, runtime)).rejects.toMatchObject({
      code: "RUNTIME_ARTIFACT_INVALID",
    });
    expect(await pathExists(plan.skillTargetPath)).toBe(false);
  });

  it("rejects a plan that redirects the canonical source", async () => {
    const { root, runtime, plan } = await fixture("opencode");
    const redirected = {
      ...plan,
      skillSourcePath: resolve(root, "untrusted-skill"),
    };

    await expect(
      materializeHostAssets(redirected, runtime),
    ).rejects.toMatchObject({ code: "HOST_ASSET_INVALID" });
    expect(await pathExists(plan.skillTargetPath)).toBe(false);
  });
});
