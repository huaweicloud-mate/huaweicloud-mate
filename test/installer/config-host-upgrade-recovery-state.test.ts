import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseConfigHostUpgradeRecovery,
  readConfigHostUpgradeRecovery,
  removeConfigHostUpgradeRecovery,
  replaceConfigHostUpgradeRecovery,
  type ConfigHostUpgradeRecovery,
} from "../../src/installer/config-host-upgrade-recovery-state.js";

const roots: string[] = [];

function recovery(
  overrides: Partial<ConfigHostUpgradeRecovery> = {},
): ConfigHostUpgradeRecovery {
  return {
    schemaVersion: 1,
    host: "opencode",
    oldStateSha256: `sha256:${"1".repeat(64)}`,
    oldPluginVersion: "0.0.0-old",
    oldInstallManifestSha256: `sha256:${"2".repeat(64)}`,
    oldActiveRuntimeSha256: `sha256:${"3".repeat(64)}`,
    candidatePluginVersion: "0.0.1-new",
    candidateInstallManifestSha256: `sha256:${"4".repeat(64)}`,
    candidateAssetTreeHash: `sha256:${"5".repeat(64)}`,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("config-host upgrade recovery state", () => {
  it("writes, CAS-replaces, reads and removes one strict marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-config-recovery-"));
    roots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    await mkdir(runtimeRoot);

    const created = await replaceConfigHostUpgradeRecovery(
      runtimeRoot,
      recovery(),
      null,
    );
    const replaced = await replaceConfigHostUpgradeRecovery(
      runtimeRoot,
      recovery({
        candidateActiveRuntimeSha256: `sha256:${"6".repeat(64)}`,
      }),
      created.sha256,
    );

    await expect(readConfigHostUpgradeRecovery(runtimeRoot)).resolves.toEqual(
      replaced,
    );
    await removeConfigHostUpgradeRecovery(runtimeRoot, replaced.sha256);
    await expect(readConfigHostUpgradeRecovery(runtimeRoot)).resolves.toBeUndefined();
  });

  it("accepts CodeArts but rejects unknown fields and same-version markers", () => {
    expect(parseConfigHostUpgradeRecovery(recovery({ host: "codearts" })).host)
      .toBe("codearts");
    expect(() => parseConfigHostUpgradeRecovery({
      ...recovery(),
      unexpected: true,
    })).toThrowError(expect.objectContaining({ code: "UPGRADE_RECOVERY_INVALID" }));
    expect(() => parseConfigHostUpgradeRecovery(recovery({
      candidatePluginVersion: "0.0.0-old",
      candidateInstallManifestSha256: `sha256:${"2".repeat(64)}`,
    }))).toThrowError(expect.objectContaining({ code: "UPGRADE_RECOVERY_INVALID" }));
  });

  it("fails closed on a stale CAS digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-config-recovery-cas-"));
    roots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    await mkdir(runtimeRoot);
    await replaceConfigHostUpgradeRecovery(runtimeRoot, recovery(), null);

    await expect(replaceConfigHostUpgradeRecovery(
      runtimeRoot,
      recovery({ host: "codearts" }),
      `sha256:${"9".repeat(64)}`,
    )).rejects.toMatchObject({ code: "UPGRADE_RECOVERY_CONFLICT" });
  });
});
