import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCodexPluginActivation,
  rollbackCodexPluginActivation,
  verifyCodexPluginActivation,
} from "../../src/installer/codex-activation.js";
import {
  codexInstalledEntry,
  FakeCodexPluginRunner,
} from "../fixtures/codex-plugin-runner.js";

const temporaryRoots: string[] = [];

async function fixture(installed = false): Promise<FakeCodexPluginRunner> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-codex-activation-"));
  temporaryRoots.push(root);
  return new FakeCodexPluginRunner(
    root,
    installed ? codexInstalledEntry() : undefined,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Codex CLI plugin activation", () => {
  it("installs, verifies, and removes a newly activated plugin", async () => {
    const runner = await fixture();
    const change = await applyCodexPluginActivation("personal", runner);

    expect(change).toMatchObject({
      kind: "codex-cli-plugin",
      pluginName: "huaweicloud-mate",
      marketplaceName: "personal",
      version: "local",
      changed: true,
      installed: true,
      enabled: true,
    });
    await expect(
      verifyCodexPluginActivation(change, runner),
    ).resolves.toBeUndefined();
    await expect(
      rollbackCodexPluginActivation(change, runner),
    ).resolves.toBeUndefined();
    expect(runner.installedEntry).toBeUndefined();
    expect(runner.invocations).toContain(
      "plugin remove huaweicloud-mate@personal --json",
    );
  });

  it("does not claim or remove a pre-existing enabled installation", async () => {
    const runner = await fixture(true);
    const change = await applyCodexPluginActivation("personal", runner);

    expect(change.changed).toBe(false);
    expect(runner.invocations).not.toContain(
      "plugin add huaweicloud-mate@personal --json",
    );
    await rollbackCodexPluginActivation(change, runner);
    expect(runner.installedEntry).toBeDefined();
    expect(runner.invocations).not.toContain(
      "plugin remove huaweicloud-mate@personal --json",
    );
  });

  it("refuses to enable a plugin that the user disabled", async () => {
    const runner = await fixture();
    runner.installedEntry = codexInstalledEntry({ enabled: false });

    await expect(
      applyCodexPluginActivation("personal", runner),
    ).rejects.toMatchObject({ code: "CODEX_ACTIVATION_CONFLICT" });
    expect(runner.invocations).not.toContain(
      "plugin add huaweicloud-mate@personal --json",
    );
  });

  it("accepts a failed add exit when the JSON list proves activation", async () => {
    const runner = await fixture();
    runner.addCode = 1;

    const change = await applyCodexPluginActivation("personal", runner);
    expect(change.changed).toBe(true);
    expect(runner.installedEntry).toBeDefined();
  });

  it("reports an unknown outcome when post-add evidence cannot be read", async () => {
    const runner = await fixture();
    runner.failingListCalls.add(2);

    await expect(
      applyCodexPluginActivation("personal", runner),
    ).rejects.toMatchObject({ code: "CODEX_ACTIVATION_OUTCOME_UNKNOWN" });
    expect(runner.installedEntry).toBeDefined();
  });

  it("refuses rollback after installed evidence changes", async () => {
    const runner = await fixture();
    const change = await applyCodexPluginActivation("personal", runner);
    runner.installedEntry = codexInstalledEntry({ version: "user-update" });

    await expect(
      rollbackCodexPluginActivation(change, runner),
    ).rejects.toMatchObject({ code: "CODEX_ACTIVATION_ROLLBACK_CONFLICT" });
    expect(runner.installedEntry?.version).toBe("user-update");
  });

  it("uses the verified postcondition when remove exits non-zero", async () => {
    const runner = await fixture();
    const change = await applyCodexPluginActivation("personal", runner);
    runner.removeCode = 1;

    await expect(
      rollbackCodexPluginActivation(change, runner),
    ).resolves.toBeUndefined();
    expect(runner.installedEntry).toBeUndefined();
  });
});
