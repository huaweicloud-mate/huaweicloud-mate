import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  armed: false,
  readCount: 0,
  replacement: "",
  targetPath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = args[0];
      if (
        race.armed &&
        typeof path === "string" &&
        resolve(path) === race.targetPath
      ) {
        race.readCount += 1;
        if (race.readCount === 2) {
          race.armed = false;
          await actual.writeFile(path, race.replacement, "utf8");
        }
      }
      return actual.readFile(...args);
    },
  };
});

import {
  applyCodexMarketplaceChange,
  createCodexMarketplacePlan,
} from "../../src/installer/codex-marketplace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  race.armed = false;
  race.readCount = 0;
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Codex marketplace transaction race checks", () => {
  it("does not overwrite a user edit made after the initial read", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-market-race-"));
    temporaryRoots.push(root);
    const home = resolve(root, "home");
    const pluginPath = resolve(home, "plugins", "huaweicloud-mate");
    await mkdir(resolve(pluginPath, ".codex-plugin"), { recursive: true });
    await writeFile(
      resolve(pluginPath, ".codex-plugin", "plugin.json"),
      '{"name":"huaweicloud-mate"}\n',
      "utf8",
    );
    const plan = createCodexMarketplacePlan(pluginPath);
    const backupDirectory = resolve(root, "backups");
    const original = '{"name":"personal","plugins":[]}\n';
    const userEdit = '{"name":"personal","plugins":[],"userEdit":true}\n';
    await mkdir(resolve(plan.marketplacePath, ".."), { recursive: true });
    await writeFile(plan.marketplacePath, original, "utf8");

    race.armed = true;
    race.readCount = 0;
    race.replacement = userEdit;
    race.targetPath = plan.marketplacePath;

    await expect(
      applyCodexMarketplaceChange(plan, backupDirectory),
    ).rejects.toMatchObject({ code: "CODEX_MARKETPLACE_CONFLICT" });

    expect(await readFile(plan.marketplacePath, "utf8")).toBe(userEdit);
    expect(await readdir(backupDirectory)).toEqual([]);
  });
});
