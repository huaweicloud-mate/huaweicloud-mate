import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexPluginRunner } from "../fixtures/codex-plugin-runner.js";
import { applyCodexPluginActivation } from "../../src/installer/codex-activation.js";
import { applyHostConfigChange } from "../../src/installer/config-transaction.js";
import {
  applyCodexMarketplaceChange,
  createCodexMarketplacePlan,
} from "../../src/installer/codex-marketplace.js";
import {
  createInstallState,
  installStatePath,
  parseInstallState,
  readInstallState,
  replaceInstallState,
  rollbackInstallStateChange,
  type CompletedHostInstallation,
} from "../../src/installer/install-state.js";
import { materializeHostAssets } from "../../src/installer/host-assets.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import type { HostId } from "../../src/hosts/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-state-"));
  temporaryRoots.push(root);
  return root;
}

async function completedHost(
  id: HostId,
  runtime: Awaited<ReturnType<typeof materializeStableRuntime>>,
  root: string,
  existingConfig = false,
): Promise<CompletedHostInstallation> {
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const plan = createHostInstallPlan(
    registry.get(id),
    runtime,
    platform,
    resolve(root, "home"),
  );
  const assetChange = await materializeHostAssets(plan, runtime);
  if (id === "codex") {
    const registrationChange = await applyCodexMarketplaceChange(
      createCodexMarketplacePlan(plan.pluginTargetPath!),
      resolve(root, "backups", "codex-marketplace"),
    );
    const activationChange = await applyCodexPluginActivation(
      registrationChange.marketplaceName,
      new FakeCodexPluginRunner(root),
    );
    return { plan, assetChange, registrationChange, activationChange };
  }
  if (plan.mergeStrategy === "plugin-manifest") {
    return { plan, assetChange };
  }
  if (existingConfig) {
    await mkdir(dirname(plan.configPath), { recursive: true });
    await writeFile(plan.configPath, "{}\n", "utf8");
  }
  const configChange = await applyHostConfigChange(
    plan,
    resolve(root, "backups", id),
  );
  return { plan, assetChange, configChange };
}

async function fixture(ids: readonly HostId[]) {
  const root = await temporaryRoot();
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const completed = await Promise.all(
    ids.map((id) => completedHost(id, runtime, root)),
  );
  return { root, runtime, completed };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("minimal install state", () => {
  it("binds runtime, config, and asset transaction evidence", async () => {
    const { runtime, completed } = await fixture(["codearts", "codex"]);
    const state = createInstallState(runtime, completed);

    expect(state.hosts.map((host) => host.id)).toEqual(["codearts", "codex"]);
    expect(state).toMatchObject({
      schemaVersion: 1,
      pluginVersion: runtime.pluginVersion,
      installManifestSha256: runtime.installManifestSha256,
      runtimePath: runtime.versionDirectory,
      stableLauncherPath: runtime.stableLauncherPath,
    });
    expect(state.hosts[0]).toMatchObject({
      id: "codearts",
      asset: { kind: "skill", changed: true },
      config: { changed: true, createdFile: true },
    });
    expect(state.hosts[1]).toMatchObject({
      id: "codex",
      asset: { kind: "plugin", changed: true },
      registration: {
        kind: "codex-personal-marketplace",
        marketplaceName: "personal",
        pluginName: "huaweicloud-mate",
        sourcePath: "./plugins/huaweicloud-mate",
        changed: true,
        createdFile: true,
        activation: {
          kind: "codex-cli-plugin",
          pluginName: "huaweicloud-mate",
          marketplaceName: "personal",
          version: "local",
          changed: true,
          installed: true,
          enabled: true,
        },
      },
    });
    expect(state.hosts[1]).not.toHaveProperty("config");

    const change = await replaceInstallState(runtime.runtimeRoot, state, null);
    const loaded = await readInstallState(runtime.runtimeRoot);
    expect(loaded).toEqual({ state, sha256: change.installedSha256 });
    expect(await readFile(installStatePath(runtime.runtimeRoot), "utf8")).not.toContain(
      "{stableLauncherPath}",
    );
    if (process.platform !== "win32") {
      expect((await lstat(change.statePath)).mode & 0o077).toBe(0);
    }

    await rollbackInstallStateChange(change);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  });

  it("strictly rejects unknown fields and inconsistent ownership", async () => {
    const { runtime, completed } = await fixture(["opencode"]);
    const state = createInstallState(runtime, completed);
    const unknown = { ...state, receipt: "must-not-be-stored" };
    expect(() => parseInstallState(unknown)).toThrowError(
      expect.objectContaining({ code: "INSTALL_STATE_INVALID" }),
    );

    const inconsistent = structuredClone(state) as unknown as {
      hosts: Array<{ asset: { changed: boolean; createdPaths: string[] } }>;
    };
    inconsistent.hosts[0]!.asset.changed = false;
    expect(() => parseInstallState(inconsistent)).toThrowError(
      expect.objectContaining({ code: "INSTALL_STATE_INVALID" }),
    );

    const { runtime: codexRuntime, completed: codexCompleted } = await fixture([
      "codex",
    ]);
    const missingRegistration = structuredClone(
      createInstallState(codexRuntime, codexCompleted),
    ) as unknown as { hosts: Array<{ registration?: unknown }> };
    delete missingRegistration.hosts[0]!.registration;
    expect(() => parseInstallState(missingRegistration)).toThrowError(
      expect.objectContaining({ code: "INSTALL_STATE_INVALID" }),
    );

    const missingActivation = structuredClone(
      createInstallState(codexRuntime, codexCompleted),
    ) as unknown as {
      hosts: Array<{ registration: { activation?: unknown } }>;
    };
    delete missingActivation.hosts[0]!.registration.activation;
    expect(() => parseInstallState(missingActivation)).toThrowError(
      expect.objectContaining({ code: "INSTALL_STATE_INVALID" }),
    );
  });

  it("preserves verified backup evidence for an existing host config", async () => {
    const root = await temporaryRoot();
    const runtime = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot: resolve(root, "runtime"),
    });
    const completed = await completedHost("codearts", runtime, root, true);
    const state = createInstallState(runtime, [completed]);

    expect(state.hosts[0]?.config).toMatchObject({
      changed: true,
      createdFile: false,
      beforeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      backupPath: expect.stringMatching(/\.bak$/u),
      backupSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(state.hosts[0]?.config?.backupSha256).toBe(
      state.hosts[0]?.config?.beforeSha256,
    );
  });

  it("uses the expected digest as a compare-before-replace guard", async () => {
    const { runtime, completed } = await fixture(["opencode"]);
    const state = createInstallState(runtime, completed);
    const first = await replaceInstallState(runtime.runtimeRoot, state, null);
    const statePath = installStatePath(runtime.runtimeRoot);
    const externallyFormatted = `${await readFile(statePath, "utf8")}\n`;
    await writeFile(statePath, externallyFormatted, "utf8");

    await expect(
      replaceInstallState(runtime.runtimeRoot, state, first.installedSha256),
    ).rejects.toMatchObject({ code: "INSTALL_STATE_CONFLICT" });
    await expect(rollbackInstallStateChange(first)).rejects.toMatchObject({
      code: "INSTALL_STATE_ROLLBACK_CONFLICT",
    });
    expect(await readFile(statePath, "utf8")).toBe(externallyFormatted);
  });

  it("returns an idempotent result without rewriting identical state", async () => {
    const { runtime, completed } = await fixture(["codex"]);
    const state = createInstallState(runtime, completed);
    const first = await replaceInstallState(runtime.runtimeRoot, state, null);
    const before = await lstat(first.statePath);
    const repeated = await replaceInstallState(
      runtime.runtimeRoot,
      state,
      first.installedSha256,
    );

    expect(repeated).toEqual({
      statePath: first.statePath,
      changed: false,
      createdFile: false,
      installedSha256: first.installedSha256,
    });
    expect((await lstat(first.statePath)).mtimeMs).toBe(before.mtimeMs);
    await rollbackInstallStateChange(repeated);
    expect(await readInstallState(runtime.runtimeRoot)).toBeDefined();
  });

  it("restores the exact previous state after a safe replacement", async () => {
    const { runtime, completed } = await fixture(["codearts", "opencode"]);
    const initialState = createInstallState(runtime, [completed[0]!]);
    const expandedState = createInstallState(runtime, completed);
    const first = await replaceInstallState(runtime.runtimeRoot, initialState, null);
    const originalBytes = await readFile(first.statePath);
    const second = await replaceInstallState(
      runtime.runtimeRoot,
      expandedState,
      first.installedSha256,
    );

    expect((await readInstallState(runtime.runtimeRoot))?.state.hosts).toHaveLength(2);
    await rollbackInstallStateChange(second);
    expect(await readFile(first.statePath)).toEqual(originalBytes);
    expect(await readInstallState(runtime.runtimeRoot)).toEqual({
      state: initialState,
      sha256: first.installedSha256,
    });
  });

  it("rejects a completed result redirected away from its install plan", async () => {
    const { runtime, completed, root } = await fixture(["opencode"]);
    const redirected = {
      ...completed[0]!,
      assetChange: {
        ...completed[0]!.assetChange,
        targetPath: resolve(root, "untrusted-target"),
      },
    };

    expect(() => createInstallState(runtime, [redirected])).toThrowError(
      expect.objectContaining({ code: "INSTALL_STATE_INVALID" }),
    );
  });

  it("refuses to write state for a runtime that no longer verifies", async () => {
    const { runtime, completed } = await fixture(["codex"]);
    const state = createInstallState(runtime, completed);
    await writeFile(
      resolve(
        runtime.versionDirectory,
        "skills",
        "canonical",
        "huaweicloud",
        "SKILL.md",
      ),
      "tampered\n",
      "utf8",
    );

    await expect(
      replaceInstallState(runtime.runtimeRoot, state, null),
    ).rejects.toMatchObject({ code: "INSTALL_STATE_INVALID" });
  });
});
