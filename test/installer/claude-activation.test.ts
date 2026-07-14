import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  applyClaudePluginActivation,
  rollbackClaudePluginActivation,
  verifyClaudePluginActivation,
} from "../../src/installer/claude-activation.js";
import {
  applyClaudeMarketplaceCatalog,
  applyClaudeMarketplaceRegistration,
  createClaudeMarketplaceCatalogPlan,
} from "../../src/installer/claude-marketplace.js";
import { materializeHostAssets } from "../../src/installer/host-assets.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";
import {
  claudePluginId as pluginId,
  FakeClaudeLifecycleRunner,
} from "../fixtures/claude-lifecycle-runner.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

async function fixture(installed = false) {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-claude-activation-"));
  temporaryRoots.push(root);
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const hostPlan = createHostInstallPlan(
    registry.get("claude"),
    runtime,
    platform,
    resolve(root, "home"),
  );
  await materializeHostAssets(hostPlan, runtime);
  const catalog = await applyClaudeMarketplaceCatalog(
    createClaudeMarketplaceCatalogPlan(
      hostPlan.pluginTargetPath!,
      runtime.pluginVersion,
    ),
  );
  const runner = new FakeClaudeLifecycleRunner(
    root,
    catalog.marketplaceRoot,
    runtime.pluginVersion,
  );
  const registration = await applyClaudeMarketplaceRegistration(
    catalog,
    runner,
  );
  if (installed) {
    runner.pluginEntry = runner.createPluginEntry();
  }
  return { catalog, registration, runner };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Claude CLI plugin activation", () => {
  it("installs, verifies, and safely removes a newly activated plugin", async () => {
    const { catalog, registration, runner } = await fixture();
    const change = await applyClaudePluginActivation(
      catalog,
      registration,
      runner,
    );

    expect(change).toMatchObject({
      kind: "claude-cli-plugin",
      pluginId,
      version: "0.0.0-development",
      scope: "user",
      changed: true,
      installed: true,
      enabled: true,
    });
    await expect(
      verifyClaudePluginActivation(change, runner),
    ).resolves.toBeUndefined();
    await expect(
      rollbackClaudePluginActivation(change, runner),
    ).resolves.toBeUndefined();
    await expect(
      rollbackClaudePluginActivation(change, runner),
    ).resolves.toBeUndefined();
    expect(runner.pluginEntry).toBeUndefined();
  }, 20_000);

  it("does not claim or remove a pre-existing enabled installation", async () => {
    const { catalog, registration, runner } = await fixture(true);
    const change = await applyClaudePluginActivation(
      catalog,
      registration,
      runner,
    );

    expect(change.changed).toBe(false);
    expect(runner.invocations).not.toContain(
      `plugin install ${pluginId} --scope user`,
    );
    await rollbackClaudePluginActivation(change, runner);
    expect(runner.pluginEntry).toBeDefined();
  }, 20_000);

  it("refuses to enable a plugin that the user disabled", async () => {
    const { catalog, registration, runner } = await fixture();
    runner.pluginEntry = runner.createPluginEntry({ enabled: false });

    await expect(
      applyClaudePluginActivation(catalog, registration, runner),
    ).rejects.toMatchObject({ code: "CLAUDE_ACTIVATION_CONFLICT" });
    expect(runner.invocations).not.toContain(
      `plugin install ${pluginId} --scope user`,
    );
  }, 20_000);

  it("accepts a failed install exit when list proves activation", async () => {
    const { catalog, registration, runner } = await fixture();
    runner.installCode = 1;

    const change = await applyClaudePluginActivation(
      catalog,
      registration,
      runner,
    );
    expect(change.changed).toBe(true);
    expect(runner.pluginEntry).toBeDefined();
  }, 20_000);

  it("preserves dependencies when the install outcome is unknown", async () => {
    const { catalog, registration, runner } = await fixture();
    runner.failingPluginListCalls.add(2);

    await expect(
      applyClaudePluginActivation(catalog, registration, runner),
    ).rejects.toMatchObject({ code: "CLAUDE_ACTIVATION_OUTCOME_UNKNOWN" });
    expect(runner.pluginEntry).toBeDefined();
    expect(runner.marketplaceEntry).toBeDefined();
  }, 20_000);

  it("rejects an existing installation at a different version", async () => {
    const { catalog, registration, runner } = await fixture();
    runner.pluginEntry = runner.createPluginEntry({
      version: "9.9.9",
      installPath: runner.pluginInstallPath("9.9.9"),
    });

    await expect(
      applyClaudePluginActivation(catalog, registration, runner),
    ).rejects.toMatchObject({ code: "CLAUDE_ACTIVATION_CONFLICT" });
  }, 20_000);

  it("preserves a plugin whose installed evidence drifted", async () => {
    const { catalog, registration, runner } = await fixture();
    const change = await applyClaudePluginActivation(
      catalog,
      registration,
      runner,
    );
    runner.pluginEntry = {
      ...runner.pluginEntry!,
      lastUpdated: "2026-07-15T00:00:00.000Z",
    };

    await expect(
      rollbackClaudePluginActivation(change, runner),
    ).rejects.toMatchObject({
      code: "CLAUDE_ACTIVATION_ROLLBACK_CONFLICT",
    });
    expect(runner.pluginEntry).toBeDefined();
  }, 20_000);

  it("uses the verified postcondition when uninstall exits non-zero", async () => {
    const { catalog, registration, runner } = await fixture();
    const change = await applyClaudePluginActivation(
      catalog,
      registration,
      runner,
    );
    runner.uninstallCode = 1;

    await expect(
      rollbackClaudePluginActivation(change, runner),
    ).resolves.toBeUndefined();
    expect(runner.pluginEntry).toBeUndefined();
  }, 20_000);
});
