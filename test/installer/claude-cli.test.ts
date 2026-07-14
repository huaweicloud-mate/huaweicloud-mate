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
import { materializeStableRuntime } from "../../src/installer/runtime.js";
import { FakeClaudeLifecycleRunner } from "../fixtures/claude-lifecycle-runner.js";

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
