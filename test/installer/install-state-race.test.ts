import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  armed: false,
  mode: "create" as "create" | "rollback",
  statePath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      const [, newPath] = args;
      if (
        race.armed &&
        race.mode === "create" &&
        typeof newPath === "string" &&
        resolve(newPath) === race.statePath
      ) {
        race.armed = false;
        await actual.writeFile(newPath, "user-created state\n", "utf8");
      }
      return actual.link(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [oldPath, newPath] = args;
      if (
        race.armed &&
        race.mode === "rollback" &&
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        resolve(oldPath) === race.statePath &&
        newPath.endsWith(".rollback")
      ) {
        race.armed = false;
        await actual.appendFile(oldPath, "\n", "utf8");
      }
      return actual.rename(...args);
    },
  };
});

import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import { materializeHostAssets } from "../../src/installer/host-assets.js";
import {
  createInstallState,
  installStatePath,
  replaceInstallState,
  rollbackInstallStateChange,
} from "../../src/installer/install-state.js";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-state-race-"));
  temporaryRoots.push(root);
  const runtime = await materializeStableRuntime({
    sourceDirectory: resolve("dist"),
    runtimeRoot: resolve(root, "runtime"),
  });
  const registry = await HostTemplateRegistry.loadBuiltIn(contractDirectory);
  const plan = createHostInstallPlan(
    registry.get("codex"),
    runtime,
    platform,
    resolve(root, "home"),
  );
  const assetChange = await materializeHostAssets(plan, runtime);
  return {
    runtime,
    state: createInstallState(runtime, [{ plan, assetChange }]),
  };
}

describe("install state race checks", () => {
  it("does not overwrite a state file that appears during first creation", async () => {
    const { runtime, state } = await fixture();
    race.armed = true;
    race.mode = "create";
    race.statePath = installStatePath(runtime.runtimeRoot);

    await expect(
      replaceInstallState(runtime.runtimeRoot, state, null),
    ).rejects.toMatchObject({ code: "INSTALL_STATE_CONFLICT" });
    expect(await readFile(race.statePath, "utf8")).toBe("user-created state\n");
    expect(
      (await readdir(runtime.runtimeRoot)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("restores a state file changed immediately before rollback capture", async () => {
    const { runtime, state } = await fixture();
    const change = await replaceInstallState(runtime.runtimeRoot, state, null);
    const installed = await readFile(change.statePath, "utf8");
    race.armed = true;
    race.mode = "rollback";
    race.statePath = change.statePath;

    await expect(rollbackInstallStateChange(change)).rejects.toMatchObject({
      code: "INSTALL_STATE_ROLLBACK_CONFLICT",
    });
    expect(await readFile(change.statePath, "utf8")).toBe(`${installed}\n`);
    expect(
      (await readdir(runtime.runtimeRoot)).filter((name) =>
        name.endsWith(".rollback"),
      ),
    ).toEqual([]);
  });
});
