import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

import { applyHostConfigChange } from "../../src/installer/config-transaction.js";

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

describe("host config transaction race checks", () => {
  it("does not overwrite a user edit made after the initial read", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-race-"));
    temporaryRoots.push(root);
    const configPath = resolve(root, "opencode.json");
    const backupDirectory = resolve(root, "backups");
    const original = '{"theme":"dark"}\n';
    const userEdit = '{"theme":"light","userEdit":true}\n';
    await writeFile(configPath, original, "utf8");

    race.armed = true;
    race.readCount = 0;
    race.replacement = userEdit;
    race.targetPath = configPath;

    await expect(
      applyHostConfigChange(
        {
          configPath,
          entryKey: "huaweicloud-agent",
          mergeStrategy: "json-object",
          configFragment: {
            mcp: {
              "huaweicloud-agent": {
                type: "local",
                command: ["node", "hcloud-agent.mjs", "router", "--stdio"],
                enabled: true,
              },
            },
          },
        },
        backupDirectory,
      ),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_CONFLICT" });

    expect(await readFile(configPath, "utf8")).toBe(userEdit);
    expect(await readdir(backupDirectory)).toEqual([]);
  });
});
