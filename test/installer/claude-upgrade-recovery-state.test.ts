import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseClaudeUpgradeRecovery,
  readClaudeUpgradeRecovery,
  removeClaudeUpgradeRecovery,
  replaceClaudeUpgradeRecovery,
  type ClaudeUpgradeRecovery,
} from "../../src/installer/claude-upgrade-recovery-state.js";

const roots: string[] = [];
const digest = (character: string): string =>
  `sha256:${character.repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-claude-recovery-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  await mkdir(runtimeRoot);
  const recovery: ClaudeUpgradeRecovery = {
    schemaVersion: 1,
    host: "claude",
    oldStateSha256: digest("1"),
    oldPluginVersion: "0.0.0-test",
    oldInstallManifestSha256: digest("2"),
    oldActiveRuntimeSha256: digest("3"),
    candidatePluginVersion: "0.0.1-test",
    candidateInstallManifestSha256: digest("4"),
    candidateAssetTreeHash: digest("5"),
    candidateCatalogSha256: digest("6"),
    candidateActivation: {
      pluginId: "huaweicloud-mate@huaweicloud-mate-local",
      version: "0.0.1-test",
      installPath: resolve(
        root,
        "cache",
        "huaweicloud-mate-local",
        "huaweicloud-mate",
        "0.0.1-test",
      ),
      installedEntryHash: digest("7"),
    },
    candidateActiveRuntimeSha256: digest("8"),
  };
  return { runtimeRoot, recovery };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Claude upgrade recovery state", () => {
  it("writes, compares, reads, and removes a strict recovery marker", async () => {
    const { runtimeRoot, recovery } = await fixture();
    const created = await replaceClaudeUpgradeRecovery(
      runtimeRoot,
      recovery,
      null,
    );
    await expect(readClaudeUpgradeRecovery(runtimeRoot)).resolves.toEqual(
      created,
    );
    await expect(
      replaceClaudeUpgradeRecovery(
        runtimeRoot,
        recovery,
        digest("0"),
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
    await removeClaudeUpgradeRecovery(runtimeRoot, created.sha256);
    await expect(readClaudeUpgradeRecovery(runtimeRoot)).resolves.toBeUndefined();
  });

  it("rejects unknown fields and pointer evidence without activation", async () => {
    const { recovery } = await fixture();
    expect(() =>
      parseClaudeUpgradeRecovery({ ...recovery, unexpected: true })
    ).toThrowError(expect.objectContaining({ code: "UPGRADE_RECOVERY_INVALID" }));
    const { candidateActivation: _activation, ...withoutActivation } = recovery;
    expect(() => parseClaudeUpgradeRecovery(withoutActivation)).toThrowError(
      expect.objectContaining({ code: "UPGRADE_RECOVERY_INVALID" }),
    );
  });
});
