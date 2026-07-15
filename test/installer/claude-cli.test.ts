import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  installStatePath,
  readInstallState,
} from "../../src/installer/install-state.js";
import {
  materializeStableRuntime,
  readActiveRuntimeSnapshot,
} from "../../src/installer/runtime.js";
import {
  readClaudeUpgradeRecovery,
  replaceClaudeUpgradeRecovery,
} from "../../src/installer/claude-upgrade-recovery-state.js";
import { FakeClaudeLifecycleRunner } from "../fixtures/claude-lifecycle-runner.js";
import { copyRuntimeCandidate } from "../fixtures/runtime-candidate.js";
import { noopRuntimePermissions } from "../fixtures/runtime-permissions.js";

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
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-claude-cli-"));
  temporaryRoots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  const homeDirectory = resolve(root, "home");
  const runner = new FakeClaudeLifecycleRunner(
    root,
    resolve(runtimeRoot, "hosts", "claude"),
    "0.0.0-development",
  );
  return {
    root,
    runtimeRoot,
    homeDirectory,
    runner,
    dependencies: {
      sourceDirectory: resolve("dist"),
      runtimeRoot,
      homeDirectory,
      runner,
      koocliArtifacts: [],
      runtimePermissions: noopRuntimePermissions,
      approvalProbe: vi.fn(async () => undefined),
    },
  };
}

function loggedJson(log: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const value = log.mock.calls.at(-1)?.[0];
  if (typeof value !== "string") {
    throw new Error("CLI did not log JSON");
  }
  return JSON.parse(value) as Record<string, unknown>;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Claude install and uninstall CLI", () => {
  it("installs, verifies, and safely uninstalls one Claude host", async () => {
    const { runtimeRoot, runner, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main(["install", "--host", "claude", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "claude",
      status: "installed",
      changed: true,
    });
    const snapshot = await readInstallState(runtimeRoot);
    expect(snapshot?.state.hosts).toHaveLength(1);
    const host = snapshot!.state.hosts[0]!;
    expect(host).toMatchObject({
      id: "claude",
      registration: {
        kind: "claude-local-marketplace",
        changed: true,
        cli: { changed: true, registered: true },
        activation: { changed: true, installed: true, enabled: true },
      },
    });
    if (host.registration?.kind !== "claude-local-marketplace") {
      throw new Error("Claude registration state is missing");
    }
    expect(await pathExists(host.asset.targetPath)).toBe(true);
    expect(await pathExists(host.registration.manifestPath)).toBe(true);
    expect(runner.marketplaceEntry).toBeDefined();
    expect(runner.pluginEntry).toBeDefined();
    expect(dependencies.approvalProbe).toHaveBeenCalledOnce();

    await expect(
      main(["uninstall", "--host", "claude", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "claude",
      status: "uninstalled",
      changed: true,
      removed: {
        activation: true,
        marketplaceRegistration: true,
        catalog: true,
        asset: true,
        state: true,
      },
    });
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(false);
    expect(await pathExists(host.asset.targetPath)).toBe(false);
    expect(runner.marketplaceEntry).toBeUndefined();
    expect(runner.pluginEntry).toBeUndefined();
    expect(await pathExists(snapshot!.state.runtimePath)).toBe(true);
  }, 30_000);

  it("treats a same-version reinstall as a verified no-op", async () => {
    const { runtimeRoot, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const before = await readFile(installStatePath(runtimeRoot));

    await expect(
      main(["install", "--host", "claude", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "claude",
      status: "unchanged",
      changed: false,
      pluginVersion: "0.0.0-development",
    });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(before);
    expect(dependencies.approvalProbe).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("upgrades owned Claude resources and keeps the previous runtime", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const previous = await readInstallState(runtimeRoot);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");

    await expect(
      main(
        ["install", "--host", "claude", "--json"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "claude",
      status: "upgraded",
      changed: true,
      previousVersion: "0.0.0-development",
      pluginVersion: "0.0.1-test",
    });
    const upgraded = await readInstallState(runtimeRoot);
    expect(upgraded?.state.pluginVersion).toBe("0.0.1-test");
    expect(upgraded?.state.hosts[0]?.registration).toMatchObject({
      kind: "claude-local-marketplace",
      pluginVersion: "0.0.1-test",
      activation: { version: "0.0.1-test" },
    });
    expect(runner.pluginEntry).toMatchObject({ version: "0.0.1-test" });
    expect(await pathExists(previous!.state.runtimePath)).toBe(true);
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      pluginVersion: "0.0.1-test",
    });

    await main(["uninstall", "--host", "claude"], dependencies);
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(false);
  }, 30_000);

  it("restores the previous Claude version when upgraded host verification fails", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const activeBefore = await readFile(
      resolve(runtimeRoot, "current", "active-runtime.json"),
    );
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");

    await expect(
      main(
        ["install", "--host", "claude"],
        {
          ...dependencies,
          sourceDirectory: candidateSource,
          approvalProbe: async () => {
            throw new Error("injected approval probe failure");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });
    const restored = await readInstallState(runtimeRoot);
    expect(restored?.state.pluginVersion).toBe("0.0.0-development");
    expect(restored?.state.hosts[0]?.registration).toMatchObject({
      kind: "claude-local-marketplace",
      pluginVersion: "0.0.0-development",
      activation: { version: "0.0.0-development" },
    });
    expect(runner.pluginEntry).toMatchObject({
      version: "0.0.0-development",
    });
    expect(
      await readFile(resolve(runtimeRoot, "current", "active-runtime.json")),
    ).toEqual(activeBefore);
    expect(await pathExists(resolve(runtimeRoot, "versions", "0.0.1-test"))).toBe(
      true,
    );
  }, 30_000);

  it("cleans a stale recovery marker after the candidate state committed", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const old = await readInstallState(runtimeRoot);
    const oldActive = await readActiveRuntimeSnapshot(runtimeRoot);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");
    await main(
      ["install", "--host", "claude"],
      { ...dependencies, sourceDirectory: candidateSource },
    );
    const candidate = await readInstallState(runtimeRoot);
    const candidateActive = await readActiveRuntimeSnapshot(runtimeRoot);
    const host = candidate!.state.hosts[0]!;
    if (host.registration?.kind !== "claude-local-marketplace") {
      throw new Error("Claude candidate registration is missing");
    }
    await replaceClaudeUpgradeRecovery(
      runtimeRoot,
      {
        schemaVersion: 1,
        host: "claude",
        oldStateSha256: old!.sha256,
        oldPluginVersion: old!.state.pluginVersion,
        oldInstallManifestSha256: old!.state.installManifestSha256,
        oldActiveRuntimeSha256: oldActive!.sha256,
        candidatePluginVersion: candidate!.state.pluginVersion,
        candidateInstallManifestSha256:
          candidate!.state.installManifestSha256,
        candidateAssetTreeHash: host.asset.installedTreeHash,
        candidateCatalogSha256: host.registration.installedSha256,
        candidateActivation: {
          pluginId: host.registration.activation.pluginId,
          version: host.registration.activation.version,
          installPath: host.registration.activation.installPath,
          installedEntryHash:
            host.registration.activation.installedEntryHash,
        },
        candidateActiveRuntimeSha256: candidateActive!.sha256,
      },
      null,
    );

    await expect(
      main(
        ["install", "--host", "claude", "--json"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).resolves.toBe(0);
    expect(await readClaudeUpgradeRecovery(runtimeRoot)).toBeUndefined();
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      sha256: candidate!.sha256,
      state: { pluginVersion: "0.0.1-test" },
    });
    expect(runner.pluginEntry).toMatchObject({ version: "0.0.1-test" });
  }, 45_000);

  it("keeps candidate dependencies when Claude activation outcome is unknown", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));
    const activeBefore = await readFile(
      resolve(runtimeRoot, "current", "active-runtime.json"),
    );
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");
    runner.failPluginListAfterInstall = true;

    await expect(
      main(
        ["install", "--host", "claude"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).rejects.toMatchObject({
      code: "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
    });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
    expect(
      await readFile(resolve(runtimeRoot, "current", "active-runtime.json")),
    ).toEqual(activeBefore);
    expect(runner.pluginEntry).toMatchObject({ version: "0.0.1-test" });
    const snapshot = await readInstallState(runtimeRoot);
    const catalog = JSON.parse(
      await readFile(
        resolve(
          snapshot!.state.hosts[0]!.registration!.marketplaceRoot,
          ".claude-plugin",
          "marketplace.json",
        ),
        "utf8",
      ),
    ) as { plugins: Array<{ version: string }> };
    expect(catalog.plugins[0]?.version).toBe("0.0.1-test");

    expect(await readClaudeUpgradeRecovery(runtimeRoot)).toBeDefined();
    await expect(
      main(["install", "--host", "codex"], dependencies),
    ).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    await expect(
      main(
        ["uninstall", "--host", "claude"],
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    await expect(
      main(
        ["install", "--host", "claude", "--json"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).resolves.toBe(0);
    expect(await readClaudeUpgradeRecovery(runtimeRoot)).toBeUndefined();
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: { pluginVersion: "0.0.1-test" },
    });
    expect(runner.pluginEntry).toMatchObject({ version: "0.0.1-test" });
  }, 45_000);

  it("keeps the managed Claude installation when a candidate source is invalid", async () => {
    const { root, runtimeRoot, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));

    await expect(
      main(
        ["install", "--host", "claude"],
        {
          ...dependencies,
          sourceDirectory: resolve(root, "missing-new-runtime"),
        },
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_INVALID" });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
  }, 30_000);

  it("preserves every dependency of a pre-existing activation", async () => {
    const { runtimeRoot, homeDirectory, runner, dependencies } = await fixture();
    const runtime = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    const registry = await HostTemplateRegistry.load(
      pathToFileURL(
        `${resolve(runtime.versionDirectory, "hosts", "templates")}${sep}`,
      ),
      pathToFileURL(
        `${resolve(runtime.versionDirectory, "contracts", "schema")}${sep}`,
      ),
    );
    const plan = createHostInstallPlan(
      registry.get("claude"),
      runtime,
      platform,
      homeDirectory,
    );
    runner.pluginEntry = runner.createPluginEntry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["install", "--host", "claude", "--json"], dependencies);
    const snapshot = await readInstallState(runtimeRoot);
    const registration = snapshot!.state.hosts[0]!.registration;
    expect(registration).toMatchObject({
      kind: "claude-local-marketplace",
      changed: true,
      cli: { changed: true },
      activation: { changed: false },
    });

    await main(["uninstall", "--host", "claude", "--json"], dependencies);
    expect(loggedJson(log)).toMatchObject({
      removed: {
        activation: false,
        marketplaceRegistration: false,
        catalog: false,
        asset: false,
        state: true,
      },
    });
    expect(runner.pluginEntry).toBeDefined();
    expect(runner.marketplaceEntry).toBeDefined();
    expect(await pathExists(plan.pluginTargetPath!)).toBe(true);
    if (registration?.kind !== "claude-local-marketplace") {
      throw new Error("Claude registration state is missing");
    }
    expect(await pathExists(registration.manifestPath)).toBe(true);
  }, 30_000);

  it("refuses to upgrade resources whose activation predated installation", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    runner.pluginEntry = runner.createPluginEntry();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");

    await expect(
      main(
        ["install", "--host", "claude"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_TRANSACTION_CONFLICT" });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
    expect(runner.pluginEntry).toMatchObject({
      version: "0.0.0-development",
    });
  }, 30_000);

  it("refuses uninstall before mutation when activation evidence drifted", async () => {
    const { runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "claude"], dependencies);
    runner.pluginEntry = {
      ...runner.pluginEntry!,
      lastUpdated: "2026-07-15T00:00:00.000Z",
    };

    await expect(
      main(["uninstall", "--host", "claude"], dependencies),
    ).rejects.toMatchObject({
      code: "CLAUDE_ACTIVATION_ROLLBACK_CONFLICT",
    });
    expect(runner.pluginEntry).toBeDefined();
    expect(runner.marketplaceEntry).toBeDefined();
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(true);
  }, 30_000);

  it("reports an absent managed installation idempotently", async () => {
    const { dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main(["uninstall", "--host", "claude", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "claude",
      status: "not-installed",
      changed: false,
    });
  });
});
