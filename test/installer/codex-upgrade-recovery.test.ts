import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  applyCodexPluginActivation,
  rollbackCodexPluginActivation,
} from "../../src/installer/codex-activation.js";
import { bindCodexInstallation } from "../../src/installer/codex-installation.js";
import { recoverInterruptedCodexUpgrade } from "../../src/installer/codex-upgrade-recovery.js";
import {
  expectedHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
} from "../../src/installer/host-assets.js";
import {
  createInstallState,
  readInstallState,
  replaceInstallState,
} from "../../src/installer/install-state.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
} from "../../src/installer/runtime.js";
import {
  codexUpgradeRecoveryPath,
  parseCodexUpgradeRecovery,
  readCodexUpgradeRecovery,
  replaceCodexUpgradeRecovery,
  type CodexUpgradeRecoverySnapshot,
} from "../../src/installer/upgrade-recovery.js";
import {
  codexInstalledEntry,
  FakeCodexPluginRunner,
} from "../fixtures/codex-plugin-runner.js";
import { copyRuntimeCandidate } from "../fixtures/runtime-candidate.js";

const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-recovery-"));
  temporaryRoots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  const homeDirectory = resolve(root, "home");
  const runner = new FakeCodexPluginRunner(
    root,
    undefined,
    new NodeHostCommandRunner(),
  );
  const dependencies = {
    sourceDirectory: resolve("dist"),
    runtimeRoot,
    homeDirectory,
    runner,
    approvalProbe: vi.fn(async () => undefined),
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main(["install", "--host", "codex"], dependencies);
  const oldSnapshot = (await readInstallState(runtimeRoot))!;
  const oldActive = (await readActiveRuntimeSnapshot(runtimeRoot))!;
  const bound = await bindCodexInstallation({
    runtimeRoot,
    snapshot: oldSnapshot,
    runner,
    homeDirectory,
    requireExecutable: true,
  });
  const candidateSource = resolve(root, "candidate-source");
  await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");
  const candidate = await materializeRuntimeCandidate({
    sourceDirectory: candidateSource,
    runtimeRoot,
  });
  const registry = await HostTemplateRegistry.load(
    pathToFileURL(
      `${resolve(candidate.versionDirectory, "hosts", "templates")}${sep}`,
    ),
    pathToFileURL(
      `${resolve(candidate.versionDirectory, "contracts", "schema")}${sep}`,
    ),
  );
  const plan = createHostInstallPlan(
    registry.get("codex"),
    candidate,
    platform,
    homeDirectory,
  );
  const marker = await replaceCodexUpgradeRecovery(
    runtimeRoot,
    {
      schemaVersion: 1,
      host: "codex",
      oldStateSha256: oldSnapshot.sha256,
      oldPluginVersion: oldSnapshot.state.pluginVersion,
      oldInstallManifestSha256: oldSnapshot.state.installManifestSha256,
      oldActiveRuntimeSha256: oldActive.sha256,
      candidatePluginVersion: candidate.pluginVersion,
      candidateInstallManifestSha256: candidate.installManifestSha256,
      candidateAssetTreeHash: await expectedHostAssetTreeHash(plan, candidate),
    },
    null,
  );
  return {
    runtimeRoot,
    homeDirectory,
    runner,
    oldSnapshot,
    oldActive,
    bound,
    candidate,
    plan,
    marker,
    candidateSource,
    dependencies,
  };
}

async function stageCandidate(
  value: Awaited<ReturnType<typeof fixture>>,
): Promise<{
  asset: Awaited<ReturnType<typeof materializeHostAssets>>;
  activation: Awaited<ReturnType<typeof applyCodexPluginActivation>>;
  marker: CodexUpgradeRecoverySnapshot;
}> {
  await rollbackCodexPluginActivation(value.bound.activationChange, value.runner);
  await rollbackHostAssetChange(value.bound.assetChange);
  const asset = await materializeHostAssets(value.plan, value.candidate);
  const activation = await applyCodexPluginActivation(
    value.bound.registrationChange.marketplaceName,
    value.runner,
  );
  let marker = await replaceCodexUpgradeRecovery(
    value.runtimeRoot,
    {
      ...value.marker.recovery,
      candidateActivation: {
        pluginId: activation.pluginId,
        version: activation.version,
        installedEntryHash: activation.installedEntryHash,
      },
    },
    value.marker.sha256,
  );
  const active = await activateMaterializedRuntime(
    value.candidate,
    value.oldActive.sha256,
  );
  marker = await replaceCodexUpgradeRecovery(
    value.runtimeRoot,
    {
      ...marker.recovery,
      candidateActiveRuntimeSha256: active.installedSha256,
    },
    marker.sha256,
  );
  return { asset, activation, marker };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Codex upgrade recovery", () => {
  it("restores the previous installation from a fully staged candidate", async () => {
    const value = await fixture();
    await stageCandidate(value);

    await expect(
      recoverInterruptedCodexUpgrade(
        value.runtimeRoot,
        value.homeDirectory,
        value.runner,
      ),
    ).resolves.toBe("rolled-back");

    expect((await readInstallState(value.runtimeRoot))?.sha256).toBe(
      value.oldSnapshot.sha256,
    );
    expect(await readActiveRuntimeSnapshot(value.runtimeRoot)).toMatchObject({
      pluginVersion: value.oldSnapshot.state.pluginVersion,
      sha256: value.oldActive.sha256,
    });
    expect(
      JSON.parse(
        await readFile(
          resolve(
            value.bound.assetChange.targetPath,
            ".codex-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: value.oldSnapshot.state.pluginVersion });
    expect(await pathExists(codexUpgradeRecoveryPath(value.runtimeRoot))).toBe(
      false,
    );
  }, 30_000);

  it("cleans a stale marker after the candidate state was committed", async () => {
    const value = await fixture();
    const staged = await stageCandidate(value);
    const state = createInstallState(value.candidate, [
      {
        plan: value.plan,
        assetChange: staged.asset,
        registrationChange: value.bound.registrationChange,
        activationChange: staged.activation,
      },
    ]);
    await replaceInstallState(
      value.runtimeRoot,
      state,
      value.oldSnapshot.sha256,
    );

    await expect(
      recoverInterruptedCodexUpgrade(
        value.runtimeRoot,
        value.homeDirectory,
        value.runner,
      ),
    ).resolves.toBe("completed");
    expect((await readInstallState(value.runtimeRoot))?.state.pluginVersion).toBe(
      value.candidate.pluginVersion,
    );
    expect(await readCodexUpgradeRecovery(value.runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("recovers before the next install retries the candidate upgrade", async () => {
    const value = await fixture();
    await stageCandidate(value);

    await expect(
      main(
        ["install", "--host", "codex"],
        { ...value.dependencies, sourceDirectory: value.candidateSource },
      ),
    ).resolves.toBe(0);
    expect((await readInstallState(value.runtimeRoot))?.state.pluginVersion).toBe(
      value.candidate.pluginVersion,
    );
    expect(await readCodexUpgradeRecovery(value.runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("preserves an unrecorded activation outcome for manual diagnosis", async () => {
    const value = await fixture();
    await rollbackCodexPluginActivation(value.bound.activationChange, value.runner);
    await rollbackHostAssetChange(value.bound.assetChange);
    await materializeHostAssets(value.plan, value.candidate);
    value.runner.installedEntry = codexInstalledEntry({
      version: "unrecorded-candidate",
    });

    await expect(
      recoverInterruptedCodexUpgrade(
        value.runtimeRoot,
        value.homeDirectory,
        value.runner,
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    expect(await readCodexUpgradeRecovery(value.runtimeRoot)).toBeDefined();
    expect(
      JSON.parse(
        await readFile(
          resolve(
            value.bound.assetChange.targetPath,
            ".codex-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: value.candidate.pluginVersion });
  }, 30_000);

  it("rejects unknown recovery marker fields", () => {
    expect(() =>
      parseCodexUpgradeRecovery({
        schemaVersion: 1,
        host: "codex",
        oldStateSha256: `sha256:${"1".repeat(64)}`,
        oldPluginVersion: "0.0.0-old",
        oldInstallManifestSha256: `sha256:${"2".repeat(64)}`,
        oldActiveRuntimeSha256: `sha256:${"3".repeat(64)}`,
        candidatePluginVersion: "0.0.1-new",
        candidateInstallManifestSha256: `sha256:${"4".repeat(64)}`,
        candidateAssetTreeHash: `sha256:${"5".repeat(64)}`,
        unexpected: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "UPGRADE_RECOVERY_INVALID" }));
  });

  it("blocks a fresh install when a recovery marker has no install state", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-orphan-recovery-"));
    temporaryRoots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    await mkdir(runtimeRoot);
    await replaceCodexUpgradeRecovery(
      runtimeRoot,
      {
        schemaVersion: 1,
        host: "codex",
        oldStateSha256: `sha256:${"1".repeat(64)}`,
        oldPluginVersion: "0.0.0-old",
        oldInstallManifestSha256: `sha256:${"2".repeat(64)}`,
        oldActiveRuntimeSha256: `sha256:${"3".repeat(64)}`,
        candidatePluginVersion: "0.0.1-new",
        candidateInstallManifestSha256: `sha256:${"4".repeat(64)}`,
        candidateAssetTreeHash: `sha256:${"5".repeat(64)}`,
      },
      null,
    );

    await expect(
      main(["install", "--host", "codex"], { runtimeRoot }),
    ).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    expect(await pathExists(resolve(runtimeRoot, "versions"))).toBe(false);
  });
});
