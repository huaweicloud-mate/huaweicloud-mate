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

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  applyClaudeMarketplaceCatalog,
  applyClaudeMarketplaceRegistration,
  createClaudeMarketplaceCatalogPlan,
  rollbackClaudeMarketplaceCatalog,
  rollbackClaudeMarketplaceRegistration,
  verifyClaudeMarketplaceCatalog,
  verifyClaudeMarketplaceRegistration,
} from "../../src/installer/claude-marketplace.js";
import {
  materializeHostAssets,
  rollbackHostAssetChange,
} from "../../src/installer/host-assets.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

interface MarketplaceListEntry extends Record<string, unknown> {
  name: string;
  source: string;
  path: string;
}

function commandResult(code: number, stdout = ""): HostCommandResult {
  return { code, signal: null, stdout, stderr: "" };
}

class FakeClaudeMarketplaceRunner implements HostCommandRunner {
  readonly executablePath: string;
  readonly invocations: string[] = [];
  entry: MarketplaceListEntry | undefined;
  addMutates = true;
  removeMutates = true;
  addCode = 0;
  readonly failingListCalls = new Set<number>();
  private listCallCount = 0;

  constructor(
    root: string,
    readonly marketplaceRoot: string,
    entry?: MarketplaceListEntry,
  ) {
    this.executablePath = resolve(root, "fake-bin", "claude.exe");
    this.entry = entry;
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    return command === "claude" ? this.executablePath : undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    if (executablePath !== this.executablePath) {
      throw new Error("Unexpected executable path");
    }
    const invocation = args.join(" ");
    this.invocations.push(invocation);
    if (invocation === `plugin validate ${this.marketplaceRoot}`) {
      return commandResult(0, "Validation passed\n");
    }
    if (invocation === "plugin marketplace list --json") {
      this.listCallCount += 1;
      if (this.failingListCalls.has(this.listCallCount)) {
        throw new Error("Injected Claude marketplace list failure");
      }
      return commandResult(
        0,
        `${JSON.stringify(this.entry === undefined ? [] : [this.entry])}\n`,
      );
    }
    if (
      invocation ===
      `plugin marketplace add ${this.marketplaceRoot} --scope user`
    ) {
      if (this.addMutates) {
        this.entry = {
          name: "huaweicloud-mate-local",
          source: "directory",
          path: this.marketplaceRoot,
          installLocation: this.marketplaceRoot,
          lastUpdated: "2026-07-14T00:00:00.000Z",
        };
      }
      return commandResult(this.addCode);
    }
    if (
      invocation ===
      "plugin marketplace remove huaweicloud-mate-local"
    ) {
      if (this.removeMutates) {
        this.entry = undefined;
      }
      return commandResult(0);
    }
    throw new Error(`Unexpected Claude invocation: ${invocation}`);
  }
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-claude-market-"));
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
  const asset = await materializeHostAssets(hostPlan, runtime);
  const catalogPlan = createClaudeMarketplaceCatalogPlan(
    hostPlan.pluginTargetPath!,
    runtime.pluginVersion,
  );
  const catalog = await applyClaudeMarketplaceCatalog(catalogPlan);
  const runner = new FakeClaudeMarketplaceRunner(
    root,
    catalogPlan.marketplaceRoot,
  );
  return { root, runtime, hostPlan, asset, catalogPlan, catalog, runner };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Claude local marketplace transaction", () => {
  it("creates, registers, verifies, and safely rolls back a local marketplace", async () => {
    const { asset, catalog, runner } = await fixture();
    const manifest = JSON.parse(
      await readFile(catalog.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "huaweicloud-mate-local",
      owner: { name: "hd-vector" },
      plugins: [
        {
          name: "huaweicloud-mate",
          source: "./huaweicloud-mate",
          version: "0.0.0-development",
        },
      ],
    });
    expect(catalog).toMatchObject({
      changed: true,
      createdFile: true,
    });

    const registration = await applyClaudeMarketplaceRegistration(
      catalog,
      runner,
    );
    expect(registration).toMatchObject({
      marketplaceName: "huaweicloud-mate-local",
      source: "directory",
      changed: true,
      registered: true,
    });
    await expect(
      verifyClaudeMarketplaceRegistration(registration, runner),
    ).resolves.toBeUndefined();
    await expect(verifyClaudeMarketplaceCatalog(catalog)).resolves.toBeUndefined();

    await rollbackClaudeMarketplaceRegistration(registration, runner);
    await rollbackClaudeMarketplaceCatalog(catalog);
    expect(runner.entry).toBeUndefined();
    expect(await pathExists(catalog.manifestPath)).toBe(false);
    expect(await pathExists(asset.targetPath)).toBe(true);
    await rollbackHostAssetChange(asset);
  }, 20_000);

  it("does not claim a matching catalog or registration that already existed", async () => {
    const { catalogPlan, catalog, runner } = await fixture();
    const repeatedCatalog = await applyClaudeMarketplaceCatalog(catalogPlan);
    runner.entry = {
      name: "huaweicloud-mate-local",
      source: "directory",
      path: catalog.marketplaceRoot,
    };

    const registration = await applyClaudeMarketplaceRegistration(
      repeatedCatalog,
      runner,
    );
    expect(repeatedCatalog.changed).toBe(false);
    expect(registration.changed).toBe(false);
    await rollbackClaudeMarketplaceRegistration(registration, runner);
    await rollbackClaudeMarketplaceCatalog(repeatedCatalog);
    expect(runner.entry).toBeDefined();
    expect(await pathExists(catalog.manifestPath)).toBe(true);
  }, 20_000);

  it("rejects a marketplace name already bound to another source", async () => {
    const { root, catalog, runner } = await fixture();
    runner.entry = {
      name: "huaweicloud-mate-local",
      source: "directory",
      path: resolve(root, "other-marketplace"),
    };

    await expect(
      applyClaudeMarketplaceRegistration(catalog, runner),
    ).rejects.toMatchObject({ code: "CLAUDE_MARKETPLACE_CONFLICT" });
    expect(
      runner.invocations.some((value) =>
        value.startsWith("plugin marketplace add "),
      ),
    ).toBe(false);
    expect(await pathExists(catalog.manifestPath)).toBe(true);
  }, 20_000);

  it("preserves a registered marketplace whose CLI entry drifted", async () => {
    const { catalog, runner } = await fixture();
    const registration = await applyClaudeMarketplaceRegistration(
      catalog,
      runner,
    );
    runner.entry = { ...runner.entry!, ref: "user-change" };

    await expect(
      rollbackClaudeMarketplaceRegistration(registration, runner),
    ).rejects.toMatchObject({
      code: "CLAUDE_MARKETPLACE_ROLLBACK_CONFLICT",
    });
    expect(runner.entry).toBeDefined();
    expect(await pathExists(catalog.manifestPath)).toBe(true);
  }, 20_000);

  it("preserves dependencies when the add outcome cannot be inspected", async () => {
    const { catalog, runner } = await fixture();
    runner.failingListCalls.add(2);

    await expect(
      applyClaudeMarketplaceRegistration(catalog, runner),
    ).rejects.toMatchObject({ code: "CLAUDE_MARKETPLACE_OUTCOME_UNKNOWN" });
    expect(runner.entry).toBeDefined();
    expect(await pathExists(catalog.manifestPath)).toBe(true);
  }, 20_000);

  it("preserves a catalog file changed after creation", async () => {
    const { catalog } = await fixture();
    const userEdit = `${await readFile(catalog.manifestPath, "utf8")}\nuser edit\n`;
    await writeFile(catalog.manifestPath, userEdit, "utf8");

    await expect(
      rollbackClaudeMarketplaceCatalog(catalog),
    ).rejects.toMatchObject({
      code: "CLAUDE_MARKETPLACE_ROLLBACK_CONFLICT",
    });
    expect(await readFile(catalog.manifestPath, "utf8")).toBe(userEdit);
  }, 20_000);
});
