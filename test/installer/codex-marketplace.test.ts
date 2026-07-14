import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCodexMarketplaceChange,
  createCodexMarketplacePlan,
  rollbackCodexMarketplaceChange,
  verifyCodexMarketplaceChange,
} from "../../src/installer/codex-marketplace.js";

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

function marketplaceEntry() {
  return {
    name: "huaweicloud-mate",
    source: {
      source: "local",
      path: "./plugins/huaweicloud-mate",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-codex-marketplace-"));
  temporaryRoots.push(root);
  const home = resolve(root, "home");
  const pluginPath = resolve(home, "plugins", "huaweicloud-mate");
  await mkdir(resolve(pluginPath, ".codex-plugin"), { recursive: true });
  await writeFile(
    resolve(pluginPath, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "huaweicloud-mate",
      version: "0.0.0-development",
    }, null, 2)}\n`,
    "utf8",
  );
  const plan = createCodexMarketplacePlan(pluginPath);
  const backupDirectory = resolve(root, "runtime", "backups", "codex-marketplace");
  return { root, home, plan, backupDirectory };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Codex personal marketplace transaction", () => {
  it("creates the fixed personal entry and safely rolls it back", async () => {
    const { home, plan, backupDirectory } = await fixture();

    expect(plan).toEqual({
      marketplacePath: resolve(home, ".agents", "plugins", "marketplace.json"),
      pluginPath: resolve(home, "plugins", "huaweicloud-mate"),
      pluginName: "huaweicloud-mate",
      sourcePath: "./plugins/huaweicloud-mate",
    });
    const change = await applyCodexMarketplaceChange(plan, backupDirectory);

    expect(change).toMatchObject({
      marketplaceName: "personal",
      changed: true,
      createdFile: true,
      installedSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      installedEntryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.parse(await readFile(plan.marketplacePath, "utf8"))).toEqual({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [marketplaceEntry()],
    });
    if (process.platform !== "win32") {
      expect((await stat(plan.marketplacePath)).mode & 0o077).toBe(0);
    }
    await verifyCodexMarketplaceChange(change);
    await rollbackCodexMarketplaceChange(change);
    expect(await pathExists(plan.marketplacePath)).toBe(false);
  });

  it("appends without dropping marketplace metadata and restores exact bytes", async () => {
    const { plan, backupDirectory } = await fixture();
    const original = `${JSON.stringify({
      name: "personal",
      interface: { displayName: "My Plugins" },
      plugins: [
        {
          name: "existing-plugin",
          source: { source: "local", path: "./plugins/existing-plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
      customMetadata: { owner: "user" },
    }, null, 4)}\n`;
    await mkdir(resolve(plan.marketplacePath, ".."), { recursive: true });
    await writeFile(plan.marketplacePath, original, "utf8");

    const change = await applyCodexMarketplaceChange(plan, backupDirectory);
    const installed = JSON.parse(await readFile(plan.marketplacePath, "utf8")) as {
      interface: { displayName: string };
      plugins: Array<{ name: string }>;
      customMetadata: { owner: string };
    };

    expect(change).toMatchObject({
      marketplaceName: "personal",
      changed: true,
      createdFile: false,
      backupPath: expect.stringMatching(/\.bak$/u),
    });
    expect(installed.interface.displayName).toBe("My Plugins");
    expect(installed.plugins.map((entry) => entry.name)).toEqual([
      "existing-plugin",
      "huaweicloud-mate",
    ]);
    expect(installed.customMetadata).toEqual({ owner: "user" });

    await rollbackCodexMarketplaceChange(change);
    expect(await readFile(plan.marketplacePath, "utf8")).toBe(original);
    expect(await pathExists(change.backupPath!)).toBe(false);
  });

  it("treats an identical entry as idempotent without rewriting", async () => {
    const { plan, backupDirectory } = await fixture();
    const original = `${JSON.stringify({
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [marketplaceEntry()],
    }, null, 2)}\n`;
    await mkdir(resolve(plan.marketplacePath, ".."), { recursive: true });
    await writeFile(plan.marketplacePath, original, "utf8");
    const before = await stat(plan.marketplacePath);

    const change = await applyCodexMarketplaceChange(plan, backupDirectory);

    expect(change).toMatchObject({ changed: false, createdFile: false });
    expect(change).not.toHaveProperty("backupPath");
    expect((await stat(plan.marketplacePath)).mtimeMs).toBe(before.mtimeMs);
    await verifyCodexMarketplaceChange(change);
    await rollbackCodexMarketplaceChange(change);
    expect(await readFile(plan.marketplacePath, "utf8")).toBe(original);
  });

  it("rejects a conflicting same-name entry without changing the file", async () => {
    const { plan, backupDirectory } = await fixture();
    const original = `${JSON.stringify({
      name: "personal",
      plugins: [
        {
          ...marketplaceEntry(),
          source: { source: "local", path: "./plugins/other" },
        },
      ],
    }, null, 2)}\n`;
    await mkdir(resolve(plan.marketplacePath, ".."), { recursive: true });
    await writeFile(plan.marketplacePath, original, "utf8");

    await expect(
      applyCodexMarketplaceChange(plan, backupDirectory),
    ).rejects.toMatchObject({ code: "CODEX_MARKETPLACE_CONFLICT" });
    expect(await readFile(plan.marketplacePath, "utf8")).toBe(original);
    expect(await pathExists(backupDirectory)).toBe(false);
  });

  it("preserves a user edit instead of rolling back over it", async () => {
    const { plan, backupDirectory } = await fixture();
    const change = await applyCodexMarketplaceChange(plan, backupDirectory);
    const userEdit = `${JSON.stringify({
      name: "personal",
      plugins: [marketplaceEntry()],
      userEdit: true,
    }, null, 2)}\n`;
    await writeFile(plan.marketplacePath, userEdit, "utf8");

    await expect(
      rollbackCodexMarketplaceChange(change),
    ).rejects.toMatchObject({ code: "CODEX_MARKETPLACE_ROLLBACK_CONFLICT" });
    expect(await readFile(plan.marketplacePath, "utf8")).toBe(userEdit);
  });

  it("rejects duplicate JSON properties before creating a backup", async () => {
    const { plan, backupDirectory } = await fixture();
    const malformed = '{"name":"personal","name":"other","plugins":[]}\n';
    await mkdir(resolve(plan.marketplacePath, ".."), { recursive: true });
    await writeFile(plan.marketplacePath, malformed, "utf8");

    await expect(
      applyCodexMarketplaceChange(plan, backupDirectory),
    ).rejects.toMatchObject({ code: "CODEX_MARKETPLACE_INVALID" });
    expect(await readFile(plan.marketplacePath, "utf8")).toBe(malformed);
    expect(await pathExists(backupDirectory)).toBe(false);
  });
});
