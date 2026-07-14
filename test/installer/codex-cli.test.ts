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
import { materializeStableRuntime } from "../../src/installer/runtime.js";
import {
  codexInstalledEntry,
  FakeCodexPluginRunner,
} from "../fixtures/codex-plugin-runner.js";

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
  }, 20_000);

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
      main(["install", "--host", "claude"], dependencies),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      "install currently supports only --host codex",
    );
    expect(await pathExists(runtimeRoot)).toBe(false);
  });

  it("rejects managed upgrade before touching a new runtime source", async () => {
    const { root, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "codex"], dependencies);

    await expect(
      main(
        ["install", "--host", "codex"],
        {
          ...dependencies,
          sourceDirectory: resolve(root, "missing-new-runtime"),
        },
      ),
    ).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_CONFLICT" });
  }, 20_000);

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
