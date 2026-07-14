import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import { materializeHostAssets } from "../../src/installer/host-assets.js";
import {
  applyCodexMarketplaceChange,
  createCodexMarketplacePlan,
} from "../../src/installer/codex-marketplace.js";
import {
  installStatePath,
  readInstallState,
} from "../../src/installer/install-state.js";
import {
  materializeStableRuntime,
  readActiveRuntimeSnapshot,
} from "../../src/installer/runtime.js";
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

async function fixture(installed = false) {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-cli-"));
  temporaryRoots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  const homeDirectory = resolve(root, "home");
  const runner = new FakeCodexPluginRunner(
    root,
    installed ? codexInstalledEntry() : undefined,
    new NodeHostCommandRunner(),
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

describe("Codex install and uninstall CLI", () => {
  it("installs, verifies, and safely uninstalls one Codex host", async () => {
    const { runtimeRoot, runner, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main(["install", "--host", "codex", "--json"], dependencies),
    ).resolves.toBe(0);
    const installed = loggedJson(log);
    expect(installed).toMatchObject({
      host: "codex",
      status: "installed",
      changed: true,
    });
    const snapshot = await readInstallState(runtimeRoot);
    expect(snapshot?.state.hosts).toHaveLength(1);
    const host = snapshot!.state.hosts[0]!;
    expect(await pathExists(host.asset.targetPath)).toBe(true);
    expect(await pathExists(host.registration!.marketplacePath)).toBe(true);
    expect(runner.installedEntry).toBeDefined();
    expect(dependencies.approvalProbe).toHaveBeenCalledOnce();

    await expect(
      main(["uninstall", "--json", "--host", "codex"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "codex",
      status: "uninstalled",
      changed: true,
      removed: {
        activation: true,
        marketplace: true,
        asset: true,
        state: true,
      },
    });
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(false);
    expect(await pathExists(host.asset.targetPath)).toBe(false);
    expect(await pathExists(host.registration!.marketplacePath)).toBe(false);
    expect(await pathExists(snapshot!.state.runtimePath)).toBe(true);
    expect(runner.installedEntry).toBeUndefined();
  }, 20_000);

  it("preserves identical resources that predated installation", async () => {
    const { root, runtimeRoot, homeDirectory, runner, dependencies } =
      await fixture(true);
    const runtime = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    const registry = await HostTemplateRegistry.load(
      pathToFileURL(`${resolve(runtime.versionDirectory, "hosts", "templates")}${sep}`),
      pathToFileURL(`${resolve(runtime.versionDirectory, "contracts", "schema")}${sep}`),
    );
    const plan = createHostInstallPlan(
      registry.get("codex"),
      runtime,
      platform,
      homeDirectory,
    );
    await materializeHostAssets(plan, runtime);
    const marketplace = await applyCodexMarketplaceChange(
      createCodexMarketplacePlan(plan.pluginTargetPath!),
      resolve(root, "preexisting-backup"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["install", "--host", "codex", "--json"], dependencies);
    const snapshot = await readInstallState(runtimeRoot);
    expect(snapshot?.state.hosts[0]).toMatchObject({
      asset: { changed: false },
      registration: {
        changed: false,
        activation: { changed: false },
      },
    });
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(
      resolve("dist"),
      candidateSource,
      "0.0.1-test",
    );
    await expect(
      main(
        ["install", "--host", "codex"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_TRANSACTION_CONFLICT" });

    await main(["uninstall", "--host", "codex", "--json"], dependencies);
    expect(loggedJson(log)).toMatchObject({
      status: "uninstalled",
      removed: {
        activation: false,
        marketplace: false,
        asset: false,
        state: true,
      },
    });
    expect(runner.installedEntry).toBeDefined();
    expect(await pathExists(plan.pluginTargetPath!)).toBe(true);
    expect(await pathExists(marketplace.marketplacePath)).toBe(true);
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(false);
  }, 30_000);

  it("refuses uninstall before mutations when a managed asset drifted", async () => {
    const { runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex", "--json"], dependencies);
    const snapshot = await readInstallState(runtimeRoot);
    const host = snapshot!.state.hosts[0]!;
    const mcpPath = resolve(host.asset.targetPath, ".mcp.json");
    await writeFile(
      mcpPath,
      `${await readFile(mcpPath, "utf8")}\nuser edit\n`,
      "utf8",
    );

    await expect(
      main(["uninstall", "--host", "codex"], dependencies),
    ).rejects.toMatchObject({ code: "HOST_ASSET_ROLLBACK_CONFLICT" });
    expect(runner.installedEntry).toBeDefined();
    expect(await pathExists(host.registration!.marketplacePath)).toBe(true);
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(true);
  }, 20_000);

  it("validates the explicit single-host scope before writing runtime files", async () => {
    const { runtimeRoot, dependencies } = await fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      main(["install", "--host", "opencode"], dependencies),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      "install supports only --host codex or --host claude",
    );
    expect(await pathExists(runtimeRoot)).toBe(false);
  });

  it("treats a same-version reinstall as a verified no-op", async () => {
    const { runtimeRoot, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));

    await expect(
      main(["install", "--host", "codex", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "codex",
      status: "unchanged",
      changed: false,
      previousVersion: "0.0.0-development",
      pluginVersion: "0.0.0-development",
    });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
    expect(dependencies.approvalProbe).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("upgrades owned Codex resources and keeps the previous runtime", async () => {
    const { root, runtimeRoot, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);
    const previous = await readInstallState(runtimeRoot);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(
      resolve("dist"),
      candidateSource,
      "0.0.1-test",
    );

    await expect(
      main(
        ["install", "--host", "codex", "--json"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "codex",
      status: "upgraded",
      changed: true,
      previousVersion: "0.0.0-development",
      pluginVersion: "0.0.1-test",
    });
    const upgraded = await readInstallState(runtimeRoot);
    expect(upgraded?.state.pluginVersion).toBe("0.0.1-test");
    expect(await pathExists(previous!.state.runtimePath)).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          resolve(
            upgraded!.state.hosts[0]!.asset.targetPath,
            ".codex-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: "0.0.1-test" });
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      pluginVersion: "0.0.1-test",
    });
    await main(["uninstall", "--host", "codex"], dependencies);
    expect(await pathExists(installStatePath(runtimeRoot))).toBe(false);
  }, 30_000);

  it("restores the old installation when upgraded host verification fails", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);
    const statePath = installStatePath(runtimeRoot);
    const stateBefore = await readFile(statePath);
    const activeBefore = await readFile(
      resolve(runtimeRoot, "current", "active-runtime.json"),
    );
    const snapshot = await readInstallState(runtimeRoot);
    const manifestPath = resolve(
      snapshot!.state.hosts[0]!.asset.targetPath,
      ".codex-plugin",
      "plugin.json",
    );
    const manifestBefore = await readFile(manifestPath);
    const installedBefore = structuredClone(runner.installedEntry);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(
      resolve("dist"),
      candidateSource,
      "0.0.1-test",
    );

    await expect(
      main(
        ["install", "--host", "codex"],
        {
          ...dependencies,
          sourceDirectory: candidateSource,
          approvalProbe: async () => {
            throw new Error("injected approval probe failure");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });
    expect(await readFile(statePath)).toEqual(stateBefore);
    expect(
      await readFile(resolve(runtimeRoot, "current", "active-runtime.json")),
    ).toEqual(activeBefore);
    expect(await readFile(manifestPath)).toEqual(manifestBefore);
    expect(runner.installedEntry).toEqual(installedBefore);
    expect(await pathExists(resolve(runtimeRoot, "versions", "0.0.1-test"))).toBe(
      true,
    );
  }, 30_000);

  it("keeps the managed installation when a candidate source is invalid", async () => {
    const { root, runtimeRoot, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));

    await expect(
      main(
        ["install", "--host", "codex"],
        {
          ...dependencies,
          sourceDirectory: resolve(root, "missing-new-runtime"),
        },
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_INVALID" });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
  }, 20_000);

  it("preserves candidate dependencies when activation outcome is unknown", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);
    const stateBefore = await readFile(installStatePath(runtimeRoot));
    const activeBefore = await readFile(
      resolve(runtimeRoot, "current", "active-runtime.json"),
    );
    const snapshot = await readInstallState(runtimeRoot);
    const pluginManifestPath = resolve(
      snapshot!.state.hosts[0]!.asset.targetPath,
      ".codex-plugin",
      "plugin.json",
    );
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(
      resolve("dist"),
      candidateSource,
      "0.0.1-test",
    );
    runner.failingListCalls.add(9);

    await expect(
      main(
        ["install", "--host", "codex"],
        { ...dependencies, sourceDirectory: candidateSource },
      ),
    ).rejects.toMatchObject({
      code: "UPGRADE_TRANSACTION_ROLLBACK_CONFLICT",
    });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
    expect(
      await readFile(resolve(runtimeRoot, "current", "active-runtime.json")),
    ).toEqual(activeBefore);
    expect(
      JSON.parse(await readFile(pluginManifestPath, "utf8")),
    ).toMatchObject({ version: "0.0.1-test" });
    expect(runner.installedEntry).toBeDefined();
  }, 30_000);

  it("reports an absent managed installation idempotently", async () => {
    const { dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main(["uninstall", "--host", "codex", "--json"], dependencies),
    ).resolves.toBe(0);
    expect(loggedJson(log)).toMatchObject({
      host: "codex",
      status: "not-installed",
      changed: false,
    });
  });
});
