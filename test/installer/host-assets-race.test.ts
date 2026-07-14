import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  armed: false,
  mode: "materialize" as "materialize" | "rollback",
  targetPath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [oldPath, newPath] = args;
      if (
        race.armed &&
        race.mode === "materialize" &&
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        resolve(newPath) === race.targetPath &&
        oldPath.endsWith(".tmp")
      ) {
        race.armed = false;
        await actual.mkdir(newPath, { recursive: true });
        await actual.writeFile(
          resolve(newPath, "user-created.txt"),
          "user content\n",
          "utf8",
        );
      } else if (
        race.armed &&
        race.mode === "rollback" &&
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        resolve(oldPath) === race.targetPath &&
        newPath.endsWith(".rollback")
      ) {
        race.armed = false;
        await actual.appendFile(
          resolve(oldPath, "SKILL.md"),
          "\nuser raced rollback\n",
          "utf8",
        );
      }
      return actual.rename(...args);
    },
  };
});

import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import {
  materializeHostAssets,
  rollbackHostAssetChange,
} from "../../src/installer/host-assets.js";
import { materializeStableRuntime } from "../../src/installer/runtime.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const platform = process.platform as "win32" | "darwin" | "linux";
const temporaryRoots: string[] = [];

afterEach(async () => {
  race.armed = false;
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("host asset materialization race checks", () => {
  it("preserves a target that appears before the atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-asset-race-"));
    temporaryRoots.push(root);
    const runtime = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot: resolve(root, "runtime"),
    });
    const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
    const plan = createHostInstallPlan(
      registry.get("opencode"),
      runtime,
      platform,
      resolve(root, "home"),
    );

    race.armed = true;
    race.mode = "materialize";
    race.targetPath = resolve(plan.skillTargetPath);

    await expect(materializeHostAssets(plan, runtime)).rejects.toMatchObject({
      code: "HOST_ASSET_CONFLICT",
    });
    expect(
      await readFile(resolve(plan.skillTargetPath, "user-created.txt"), "utf8"),
    ).toBe("user content\n");
    expect(
      (await readdir(resolve(plan.skillTargetPath, ".."))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  }, 15_000);

  it("restores user content changed immediately before rollback rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-rollback-race-"));
    temporaryRoots.push(root);
    const runtime = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot: resolve(root, "runtime"),
    });
    const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
    const plan = createHostInstallPlan(
      registry.get("opencode"),
      runtime,
      platform,
      resolve(root, "home"),
    );
    const change = await materializeHostAssets(plan, runtime);

    race.armed = true;
    race.mode = "rollback";
    race.targetPath = change.targetPath;

    await expect(rollbackHostAssetChange(change)).rejects.toMatchObject({
      code: "HOST_ASSET_ROLLBACK_CONFLICT",
    });
    expect(
      await readFile(resolve(change.targetPath, "SKILL.md"), "utf8"),
    ).toContain("user raced rollback");
    expect(
      (await readdir(resolve(change.targetPath, ".."))).filter((name) =>
        name.endsWith(".rollback"),
      ),
    ).toEqual([]);
  });
});
