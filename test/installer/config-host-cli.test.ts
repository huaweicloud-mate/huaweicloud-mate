import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import { main, type CliDependencies } from "../../src/cli.js";
import { readConfigHostUpgradeRecovery } from "../../src/installer/config-host-upgrade-recovery-state.js";
import { readInstallState } from "../../src/installer/install-state.js";
import { readActiveRuntimeSnapshot } from "../../src/installer/runtime.js";
import {
  copyRuntimeCandidate,
  rewriteRuntimeArtifact,
} from "../fixtures/runtime-candidate.js";
import { noopRuntimePermissions } from "../fixtures/runtime-permissions.js";

type ConfigHost = "opencode" | "codearts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

class ConfigHostRunner implements HostCommandRunner {
  private readonly fallback = new NodeHostCommandRunner();
  readonly opencodePath: string;

  constructor(root: string) {
    this.opencodePath = resolve(root, "opencode-test.exe");
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    return command === "opencode" ? this.opencodePath : undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<HostCommandResult> {
    if (executablePath === this.opencodePath) {
      if (args.join(" ") === "mcp list") {
        return { code: 0, signal: null, stdout: "huaweicloud-agent connected", stderr: "" };
      }
      if (args.join(" ") === "debug skill") {
        return { code: 0, signal: null, stdout: "huaweicloud", stderr: "" };
      }
      return { code: 2, signal: null, stdout: "", stderr: "unexpected" };
    }
    return this.fallback.run(executablePath, args, timeoutMs);
  }
}

describe("config-host CLI lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  async function fixture(): Promise<{
    readonly root: string;
    readonly homeDirectory: string;
    readonly runtimeRoot: string;
    readonly dependencies: CliDependencies;
  }> {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-config-host-"));
    roots.push(root);
    const homeDirectory = resolve(root, "home");
    const runtimeRoot = resolve(root, "runtime");
    return {
      root,
      homeDirectory,
      runtimeRoot,
      dependencies: {
        sourceDirectory: resolve("dist"),
        runtimeRoot,
        homeDirectory,
        runner: new ConfigHostRunner(root),
        koocliArtifacts: [],
        runtimePermissions: noopRuntimePermissions,
        approvalProbe: vi.fn(async () => undefined),
      },
    };
  }

  it.each<ConfigHost>(["opencode", "codearts"])(
    "installs, verifies, rechecks and uninstalls %s",
    async (host) => {
      const { homeDirectory, runtimeRoot, dependencies } = await fixture();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(main(["install", "--host", host, "--json"], dependencies)).resolves.toBe(0);
      const snapshot = await readInstallState(runtimeRoot);
      expect(snapshot?.state.hosts).toEqual([
        expect.objectContaining({ id: host, config: expect.any(Object) }),
      ]);
      const configPath = host === "opencode"
        ? resolve(homeDirectory, ".config", "opencode", "opencode.json")
        : resolve(homeDirectory, ".codeartsdoer", "codearts_cli.jsonc");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        mcp: {
          "huaweicloud-agent": {
            type: "local",
            enabled: true,
          },
        },
      });

      await expect(main(["install", "--host", host, "--json"], dependencies)).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        host,
        status: "unchanged",
        changed: false,
      });

      await expect(main(["uninstall", "--host", host, "--json"], dependencies)).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        host,
        status: "uninstalled",
        removed: { config: true, asset: true, state: true },
      });
      expect(await pathExists(configPath)).toBe(false);
      expect(await readInstallState(runtimeRoot)).toBeUndefined();
    },
    30_000,
  );

  it("refuses to uninstall a drifted OpenCode config", async () => {
    const { homeDirectory, runtimeRoot, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install", "--host", "opencode"], dependencies);
    const configPath = resolve(
      homeDirectory,
      ".config",
      "opencode",
      "opencode.json",
    );
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\nuser edit\n`, "utf8");

    await expect(
      main(["uninstall", "--host", "opencode"], dependencies),
    ).rejects.toMatchObject({ code: "HOST_CONFIG_ROLLBACK_CONFLICT" });
    expect(await readInstallState(runtimeRoot)).toBeDefined();
  }, 30_000);

  it.each<ConfigHost>(["opencode", "codearts"])(
    "upgrades %s across runtime versions without rewriting its stable config",
    async (host) => {
      const { root, homeDirectory, runtimeRoot, dependencies } = await fixture();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await main(["install", "--host", host, "--json"], dependencies);
      const configPath = host === "opencode"
        ? resolve(homeDirectory, ".config", "opencode", "opencode.json")
        : resolve(homeDirectory, ".codeartsdoer", "codearts_cli.jsonc");
      const configBefore = await readFile(configPath);
      const candidateSource = resolve(root, "candidate-source");
      await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");

      await expect(main(["install", "--host", host, "--json"], {
        ...dependencies,
        sourceDirectory: candidateSource,
      })).resolves.toBe(0);

      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        host,
        status: "upgraded",
        previousVersion: "0.0.0-development",
        pluginVersion: "0.0.1-test",
      });
      expect(await readFile(configPath)).toEqual(configBefore);
      expect(await readInstallState(runtimeRoot)).toMatchObject({
        state: { pluginVersion: "0.0.1-test" },
      });
      expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
        pluginVersion: "0.0.1-test",
      });
      expect(await readConfigHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
    },
    30_000,
  );

  it("replaces a changed CodeArts Skill while preserving the original config rollback", async () => {
    const { root, homeDirectory, runtimeRoot, dependencies } = await fixture();
    const configDirectory = resolve(homeDirectory, ".codeartsdoer");
    const configPath = resolve(configDirectory, "codearts_cli.jsonc");
    await mkdir(configDirectory, { recursive: true });
    const originalConfig = '{\n  // preserved user setting\n  "theme": "dark"\n}\n';
    await writeFile(configPath, originalConfig);
    await main(["install", "--host", "codearts"], dependencies);
    const oldState = (await readInstallState(runtimeRoot))!;
    const oldBackupPath = oldState.state.hosts[0]?.config?.backupPath;
    const candidateSource = resolve(root, "candidate-skill-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.2-test");
    await rewriteRuntimeArtifact(
      candidateSource,
      "skills/canonical/huaweicloud/SKILL.md",
      (text) => `${text.trimEnd()}\n\nUpgraded fixture marker.\n`,
    );

    await main(["install", "--host", "codearts"], {
      ...dependencies,
      sourceDirectory: candidateSource,
    });

    const upgraded = (await readInstallState(runtimeRoot))!;
    expect(upgraded.state.pluginVersion).toBe("0.0.2-test");
    expect(upgraded.state.hosts[0]?.config?.backupPath).toBe(oldBackupPath);
    expect(await readFile(
      resolve(homeDirectory, ".codeartsdoer", "skills", "huaweicloud", "SKILL.md"),
      "utf8",
    )).toContain("Upgraded fixture marker.");

    await main(["uninstall", "--host", "codearts"], dependencies);
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  }, 30_000);

  it("restores old config-host evidence when upgrade verification fails", async () => {
    const { root, homeDirectory, runtimeRoot, dependencies } = await fixture();
    await main(["install", "--host", "codearts"], dependencies);
    const statePath = resolve(runtimeRoot, "install-state.json");
    const activePath = resolve(runtimeRoot, "current", "active-runtime.json");
    const skillPath = resolve(
      homeDirectory,
      ".codeartsdoer",
      "skills",
      "huaweicloud",
      "SKILL.md",
    );
    const [stateBefore, activeBefore, skillBefore] = await Promise.all([
      readFile(statePath),
      readFile(activePath),
      readFile(skillPath),
    ]);
    const candidateSource = resolve(root, "candidate-failure-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.3-test");
    await rewriteRuntimeArtifact(
      candidateSource,
      "skills/canonical/huaweicloud/SKILL.md",
      (text) => `${text.trimEnd()}\n\nShould be rolled back.\n`,
    );

    await expect(main(["install", "--host", "codearts"], {
      ...dependencies,
      sourceDirectory: candidateSource,
      approvalProbe: vi.fn(async () => {
        throw new Error("approval verification failed");
      }),
    })).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });

    await expect(Promise.all([
      readFile(statePath),
      readFile(activePath),
      readFile(skillPath),
    ])).resolves.toEqual([stateBefore, activeBefore, skillBefore]);
    expect(await readConfigHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
  }, 30_000);
});
