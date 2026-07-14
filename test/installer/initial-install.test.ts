import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import type { HostId } from "../../src/hosts/types.js";
import { runInitialInstallTransaction } from "../../src/installer/initial-install.js";
import { createCodexMarketplacePlan } from "../../src/installer/codex-marketplace.js";
import {
  installStatePath,
  readInstallState,
} from "../../src/installer/install-state.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-initial-install-"));
  temporaryRoots.push(root);
  return root;
}

async function fixture(ids: readonly HostId[]) {
  const root = await temporaryRoot();
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const plans = ids.map((id) =>
    createHostInstallPlan(
      registry.get(id),
      runtime,
      platform,
      resolve(root, "home"),
    ),
  );
  return { root, runtime, plans };
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

function assetTarget(plan: Awaited<ReturnType<typeof fixture>>["plans"][number]): string {
  return plan.mergeStrategy === "plugin-manifest"
    ? plan.pluginTargetPath as string
    : plan.skillTargetPath;
}

function codexMarketplacePath(
  plans: Awaited<ReturnType<typeof fixture>>["plans"],
): string {
  const codex = plans.find((plan) => plan.id === "codex");
  if (codex?.pluginTargetPath === undefined) {
    throw new Error("Codex plan is missing");
  }
  return createCodexMarketplacePlan(codex.pluginTargetPath).marketplacePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("initial install transaction", () => {
  it("commits install state only after integrity and host verification", async () => {
    const { runtime, plans } = await fixture(["codex", "codearts"]);
    const verify = vi.fn(async ({ completedHosts }) => {
      expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
      expect(completedHosts.map((host) => host.plan.id)).toEqual([
        "codearts",
        "codex",
      ]);
      for (const host of completedHosts) {
        expect(await pathExists(host.assetChange.targetPath)).toBe(true);
        if (host.configChange !== undefined) {
          expect(await pathExists(host.configChange.configPath)).toBe(true);
        }
        if (host.plan.id === "codex") {
          expect(host.registrationChange).toBeDefined();
          expect(
            await pathExists(host.registrationChange!.marketplacePath),
          ).toBe(true);
        }
      }
    });

    const result = await runInitialInstallTransaction({
      runtime,
      plans,
      verify,
    });

    expect(verify).toHaveBeenCalledOnce();
    expect(result.stateChange).toMatchObject({
      changed: true,
      createdFile: true,
    });
    expect(result.state.hosts.map((host) => host.id)).toEqual([
      "codearts",
      "codex",
    ]);
    expect(result.state.hosts.find((host) => host.id === "codex")).toMatchObject({
      registration: {
        kind: "codex-personal-marketplace",
        changed: true,
        createdFile: true,
      },
    });
    expect(await readInstallState(runtime.runtimeRoot)).toEqual({
      state: result.state,
      sha256: result.stateChange.installedSha256,
    });
  }, 15_000);

  it("rejects an existing install state before applying any new change", async () => {
    const { runtime, plans } = await fixture(["codex"]);
    const first = await runInitialInstallTransaction({ runtime, plans });
    const stateBytes = await readFile(installStatePath(runtime.runtimeRoot));
    const assetPath = first.completedHosts[0]!.assetChange.targetPath;

    await expect(
      runInitialInstallTransaction({ runtime, plans }),
    ).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_CONFLICT" });
    expect(await readFile(installStatePath(runtime.runtimeRoot))).toEqual(
      stateBytes,
    );
    expect(await pathExists(assetPath)).toBe(true);
  });

  it("rejects duplicate plans before materializing host assets", async () => {
    const { runtime, plans } = await fixture(["codex"]);

    await expect(
      runInitialInstallTransaction({ runtime, plans: [plans[0]!, plans[0]!] }),
    ).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_INVALID" });
    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  });

  it("rolls back every applied host when final verification fails", async () => {
    const { runtime, plans } = await fixture(["codex", "codearts"]);
    const codearts = plans.find((plan) => plan.id === "codearts")!;

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        verify: async () => {
          throw new Error("verification failed");
        },
      }),
    ).rejects.toMatchObject({ code: "INSTALL_TRANSACTION_FAILED" });

    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
    expect(await pathExists(codearts.configPath)).toBe(false);
    expect(await pathExists(codexMarketplacePath(plans))).toBe(false);
    for (const plan of plans) {
      expect(await pathExists(assetTarget(plan))).toBe(false);
    }
  });

  it("preserves a state file that appears before commit and rolls back hosts", async () => {
    const { runtime, plans } = await fixture(["codex"]);
    const statePath = installStatePath(runtime.runtimeRoot);

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        verify: async () => {
          await writeFile(statePath, "external state\n", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "INSTALL_STATE_CONFLICT" });

    expect(await readFile(statePath, "utf8")).toBe("external state\n");
    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
    expect(await pathExists(codexMarketplacePath(plans))).toBe(false);
  });

  it("preserves a conflicting config and rolls back earlier assets", async () => {
    const { runtime, plans } = await fixture(["opencode", "codex"]);
    const opencode = plans.find((plan) => plan.id === "opencode")!;
    const conflicting = `${JSON.stringify({
      mcp: {
        "huaweicloud-agent": {
          type: "local",
          command: ["other"],
          enabled: true,
        },
      },
    }, null, 2)}\n`;
    await mkdir(dirname(opencode.configPath), { recursive: true });
    await writeFile(opencode.configPath, conflicting, "utf8");

    await expect(
      runInitialInstallTransaction({ runtime, plans }),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_CONFLICT" });

    expect(await readFile(opencode.configPath, "utf8")).toBe(conflicting);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
    expect(await pathExists(codexMarketplacePath(plans))).toBe(false);
    for (const plan of plans) {
      expect(await pathExists(assetTarget(plan))).toBe(false);
    }
  });

  it("reports rollback conflict but still rolls back independent assets", async () => {
    const { runtime, plans } = await fixture(["codearts"]);
    const plan = plans[0]!;

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        verify: async () => {
          await writeFile(
            plan.configPath,
            `${await readFile(plan.configPath, "utf8")}\nuser change\n`,
            "utf8",
          );
          throw new Error("verification failed after external change");
        },
      }),
    ).rejects.toMatchObject({
      code: "INSTALL_TRANSACTION_ROLLBACK_CONFLICT",
    });

    expect(await readFile(plan.configPath, "utf8")).toContain("user change");
    expect(await pathExists(assetTarget(plan))).toBe(false);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  });

  it("preserves a Codex plugin when an edited marketplace cannot roll back", async () => {
    const { runtime, plans } = await fixture(["codex", "codearts"]);
    const marketplacePath = codexMarketplacePath(plans);
    const codex = plans.find((plan) => plan.id === "codex")!;
    const codearts = plans.find((plan) => plan.id === "codearts")!;

    await expect(
      runInitialInstallTransaction({
        runtime,
        plans,
        verify: async () => {
          const marketplace = JSON.parse(
            await readFile(marketplacePath, "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            marketplacePath,
            `${JSON.stringify({ ...marketplace, userEdit: true }, null, 2)}\n`,
            "utf8",
          );
          throw new Error("verification failed after marketplace edit");
        },
      }),
    ).rejects.toMatchObject({
      code: "INSTALL_TRANSACTION_ROLLBACK_CONFLICT",
    });

    expect(await readFile(marketplacePath, "utf8")).toContain("userEdit");
    expect(await pathExists(assetTarget(codex))).toBe(true);
    expect(await pathExists(codearts.configPath)).toBe(false);
    expect(await pathExists(assetTarget(codearts))).toBe(false);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  }, 15_000);

  it("records a pre-existing identical marketplace entry without ownership", async () => {
    const { runtime, plans } = await fixture(["codex"]);
    const marketplacePath = codexMarketplacePath(plans);
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(
      marketplacePath,
      `${JSON.stringify({
        name: "personal",
        interface: { displayName: "Personal" },
        plugins: [
          {
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
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runInitialInstallTransaction({ runtime, plans });

    expect(result.state.hosts[0]?.registration).toMatchObject({
      changed: false,
      createdFile: false,
    });
    expect(result.state.hosts[0]?.registration).not.toHaveProperty("backupPath");
  }, 15_000);

  it("preserves a conflicting Codex marketplace and rolls back its new asset", async () => {
    const { runtime, plans } = await fixture(["codex"]);
    const marketplacePath = codexMarketplacePath(plans);
    const conflicting = `${JSON.stringify({
      name: "personal",
      plugins: [
        {
          name: "huaweicloud-mate",
          source: { source: "local", path: "./plugins/other" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }, null, 2)}\n`;
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, conflicting, "utf8");

    await expect(
      runInitialInstallTransaction({ runtime, plans }),
    ).rejects.toMatchObject({ code: "CODEX_MARKETPLACE_CONFLICT" });

    expect(await readFile(marketplacePath, "utf8")).toBe(conflicting);
    expect(await pathExists(assetTarget(plans[0]!))).toBe(false);
    expect(await readInstallState(runtime.runtimeRoot)).toBeUndefined();
  });
});
