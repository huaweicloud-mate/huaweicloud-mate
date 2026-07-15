import { appendFile, lstat, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  bindConfigHostInstallation,
} from "../../src/installer/config-host-installation.js";
import { recoverInterruptedConfigHostUpgrade } from "../../src/installer/config-host-upgrade-recovery.js";
import {
  readConfigHostUpgradeRecovery,
  replaceConfigHostUpgradeRecovery,
} from "../../src/installer/config-host-upgrade-recovery-state.js";
import {
  expectedHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
} from "../../src/installer/host-assets.js";
import {
  createInstallState,
  readInstallState,
  replaceInstallState,
  type CompletedHostInstallation,
} from "../../src/installer/install-state.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
} from "../../src/installer/runtime.js";
import {
  copyRuntimeCandidate,
  rewriteRuntimeArtifact,
} from "../fixtures/runtime-candidate.js";
import { noopRuntimePermissions } from "../fixtures/runtime-permissions.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function interruptedFixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-config-interrupt-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  const homeDirectory = resolve(root, "home");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main(["install", "--host", "codearts"], {
    sourceDirectory: resolve("dist"),
    runtimeRoot,
    homeDirectory,
    runner: new NodeHostCommandRunner(),
    koocliArtifacts: [],
    runtimePermissions: noopRuntimePermissions,
    approvalProbe: vi.fn(async () => undefined),
  });
  const oldState = (await readInstallState(runtimeRoot))!;
  const oldActive = (await readActiveRuntimeSnapshot(runtimeRoot))!;
  const bound = await bindConfigHostInstallation({
    host: "codearts",
    runtimeRoot,
    snapshot: oldState,
    homeDirectory,
  });
  const candidateSource = resolve(root, "candidate-source");
  await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.4-test");
  await rewriteRuntimeArtifact(
    candidateSource,
    "skills/canonical/huaweicloud/SKILL.md",
    (text) => `${text.trimEnd()}\n\nInterrupted candidate marker.\n`,
  );
  const candidate = await materializeRuntimeCandidate({
    sourceDirectory: candidateSource,
    runtimeRoot,
  });
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(`${resolve(candidate.versionDirectory, "hosts", "templates")}${sep}`),
    pathToFileURL(`${resolve(candidate.versionDirectory, "contracts", "schema")}${sep}`),
  );
  const plan = createHostInstallPlan(
    registry.get("codearts"),
    candidate,
    process.platform as "win32" | "darwin" | "linux",
    homeDirectory,
  );
  const candidateAssetTreeHash = await expectedHostAssetTreeHash(plan, candidate);
  const marker = await replaceConfigHostUpgradeRecovery(
    runtimeRoot,
    {
      schemaVersion: 1,
      host: "codearts",
      oldStateSha256: oldState.sha256,
      oldPluginVersion: oldState.state.pluginVersion,
      oldInstallManifestSha256: oldState.state.installManifestSha256,
      oldActiveRuntimeSha256: oldActive.sha256,
      candidatePluginVersion: candidate.pluginVersion,
      candidateInstallManifestSha256: candidate.installManifestSha256,
      candidateAssetTreeHash,
    },
    null,
  );
  await rollbackHostAssetChange(bound.assetChange);
  const candidateAsset = await materializeHostAssets(plan, candidate);
  const candidateActive = await activateMaterializedRuntime(
    candidate,
    oldActive.sha256,
  );
  return {
    root,
    runtimeRoot,
    homeDirectory,
    oldState,
    oldActive,
    bound,
    candidate,
    plan,
    candidateAsset,
    candidateActive,
    marker,
  };
}

describe("config-host interrupted upgrade recovery", () => {
  it("restores the old state, pointer, and Skill after a crash before state commit", async () => {
    const value = await interruptedFixture();
    const stateBytes = await readFile(resolve(value.runtimeRoot, "install-state.json"));

    await recoverInterruptedConfigHostUpgrade(
      value.runtimeRoot,
      value.homeDirectory,
    );

    expect(await readFile(resolve(value.runtimeRoot, "install-state.json")))
      .toEqual(stateBytes);
    expect(await readActiveRuntimeSnapshot(value.runtimeRoot)).toMatchObject({
      sha256: value.oldActive.sha256,
      pluginVersion: value.oldState.state.pluginVersion,
    });
    expect(await readFile(
      resolve(value.bound.assetChange.targetPath, "SKILL.md"),
      "utf8",
    )).not.toContain("Interrupted candidate marker.");
    expect(await readConfigHostUpgradeRecovery(value.runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("accepts a committed candidate and removes only the stale marker", async () => {
    const value = await interruptedFixture();
    const completed: CompletedHostInstallation = {
      plan: value.plan,
      configChange: value.bound.configChange,
      assetChange: value.candidateAsset,
    };
    const candidateState = createInstallState(value.candidate, [completed]);
    await replaceInstallState(
      value.runtimeRoot,
      candidateState,
      value.oldState.sha256,
    );

    await recoverInterruptedConfigHostUpgrade(
      value.runtimeRoot,
      value.homeDirectory,
    );

    expect(await readInstallState(value.runtimeRoot)).toMatchObject({
      state: { pluginVersion: value.candidate.pluginVersion },
    });
    expect(await readActiveRuntimeSnapshot(value.runtimeRoot)).toMatchObject({
      pluginVersion: value.candidate.pluginVersion,
    });
    expect(await readFile(
      resolve(value.candidateAsset.targetPath, "SKILL.md"),
      "utf8",
    )).toContain("Interrupted candidate marker.");
    expect(await readConfigHostUpgradeRecovery(value.runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("blocks another host and uninstall while config-host recovery is pending", async () => {
    const value = await interruptedFixture();
    const dependencies = {
      sourceDirectory: resolve("dist"),
      runtimeRoot: value.runtimeRoot,
      homeDirectory: value.homeDirectory,
      runner: new NodeHostCommandRunner(),
      koocliArtifacts: [],
      runtimePermissions: noopRuntimePermissions,
      approvalProbe: vi.fn(async () => undefined),
    };

    await expect(main(["install", "--host", "opencode"], dependencies))
      .rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    await expect(main(["uninstall", "--host", "codearts"], dependencies))
      .rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    expect(await readConfigHostUpgradeRecovery(value.runtimeRoot)).toBeDefined();
  }, 30_000);

  it("removes a hash-proven candidate quarantine left by forced termination", async () => {
    const value = await interruptedFixture();
    const quarantinePath = resolve(
      dirname(value.candidateAsset.targetPath),
      `.${basename(value.candidateAsset.targetPath)}.${"a".repeat(32)}.rollback`,
    );
    await rename(value.candidateAsset.targetPath, quarantinePath);

    await recoverInterruptedConfigHostUpgrade(
      value.runtimeRoot,
      value.homeDirectory,
    );

    await expect(lstat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(
      resolve(value.bound.assetChange.targetPath, "SKILL.md"),
      "utf8",
    )).not.toContain("Interrupted candidate marker.");
    expect(await readConfigHostUpgradeRecovery(value.runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("preserves and rejects a rollback quarantine with unknown content", async () => {
    const value = await interruptedFixture();
    const quarantinePath = resolve(
      dirname(value.candidateAsset.targetPath),
      `.${basename(value.candidateAsset.targetPath)}.${"b".repeat(32)}.rollback`,
    );
    await rename(value.candidateAsset.targetPath, quarantinePath);
    const quarantinedSkill = resolve(quarantinePath, "SKILL.md");
    await appendFile(quarantinedSkill, "\nunknown edit\n");

    await expect(recoverInterruptedConfigHostUpgrade(
      value.runtimeRoot,
      value.homeDirectory,
    )).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });

    await expect(lstat(quarantinePath)).resolves.toMatchObject({});
    expect(await readConfigHostUpgradeRecovery(value.runtimeRoot)).toBeDefined();
  }, 30_000);
});
