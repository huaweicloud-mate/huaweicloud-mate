import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, type CliDependencies } from "../../src/cli.js";
import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import { createHostInstallPlan } from "../../src/hosts/plan.js";
import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import { applyCodexPluginActivation, rollbackCodexPluginActivation } from "../../src/installer/codex-activation.js";
import { bindCodexInstallation } from "../../src/installer/codex-installation.js";
import {
  expectedHostAssetTreeHash,
  materializeHostAssets,
  rollbackHostAssetChange,
} from "../../src/installer/host-assets.js";
import {
  installStatePath,
  readInstallState,
} from "../../src/installer/install-state.js";
import {
  readMultiHostUpgradeRecovery,
  replaceMultiHostUpgradeRecovery,
} from "../../src/installer/multi-host-upgrade-recovery-state.js";
import { recoverInterruptedMultiHostUpgrade } from "../../src/installer/multi-host-upgrade.js";
import {
  materializeRuntimeCandidate,
  readActiveRuntimeSnapshot,
} from "../../src/installer/runtime.js";
import { FakeCodexPluginRunner } from "../fixtures/codex-plugin-runner.js";
import { FakeClaudeLifecycleRunner } from "../fixtures/claude-lifecycle-runner.js";
import { copyRuntimeCandidate } from "../fixtures/runtime-candidate.js";
import { noopRuntimePermissions } from "../fixtures/runtime-permissions.js";

class OpenCodeRunner implements HostCommandRunner {
  readonly executablePath: string;
  readonly #fallback = new NodeHostCommandRunner();

  constructor(root: string) {
    this.executablePath = resolve(root, "fake-bin", "opencode.exe");
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    if (command === "opencode") return this.executablePath;
    if (command === "claude" || command === "codearts") return undefined;
    return await this.#fallback.resolveCommand(command);
  }

  async run(
    executablePath: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<HostCommandResult> {
    if (executablePath === this.executablePath) {
      const invocation = args.join(" ");
      if (invocation === "mcp list") {
        return {
          code: 0,
          signal: null,
          stdout: "huaweicloud-agent connected\n",
          stderr: "",
        };
      }
      if (invocation === "debug skill") {
        return {
          code: 0,
          signal: null,
          stdout: "huaweicloud\n",
          stderr: "",
        };
      }
    }
    return await this.#fallback.run(executablePath, args, timeoutMs);
  }
}

class NoHostRunner implements HostCommandRunner {
  async resolveCommand(): Promise<undefined> {
    return undefined;
  }

  async run(): Promise<HostCommandResult> {
    throw new Error("No command should run without a detected host");
  }
}

describe("automatic host installation", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true })
      ),
    );
  });

  async function fixture(): Promise<{
    readonly root: string;
    readonly runtimeRoot: string;
    readonly runner: FakeCodexPluginRunner;
    readonly dependencies: CliDependencies;
  }> {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-auto-host-"));
    roots.push(root);
    const opencode = new OpenCodeRunner(root);
    const runner = new FakeCodexPluginRunner(root, undefined, opencode);
    return {
      root,
      runtimeRoot: resolve(root, "runtime"),
      runner,
      dependencies: {
        sourceDirectory: resolve("dist"),
        runtimeRoot: resolve(root, "runtime"),
        homeDirectory: resolve(root, "home"),
        runner,
        koocliArtifacts: [],
        runtimePermissions: noopRuntimePermissions,
        approvalProbe: vi.fn(async () => undefined),
      },
    };
  }

  async function allHostFixture(): Promise<{
    readonly root: string;
    readonly runtimeRoot: string;
    readonly dependencies: CliDependencies;
  }> {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-all-host-"));
    roots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    const homeDirectory = resolve(root, "home");
    const codeartsDirectory = resolve(homeDirectory, ".codeartsdoer");
    await mkdir(codeartsDirectory, { recursive: true });
    await writeFile(resolve(codeartsDirectory, "codearts_cli.jsonc"), "{}\n");
    const opencode = new OpenCodeRunner(root);
    const claude = new FakeClaudeLifecycleRunner(
      root,
      resolve(runtimeRoot, "hosts", "claude"),
      "0.0.0-development",
      opencode,
    );
    const runner = new FakeCodexPluginRunner(root, undefined, claude);
    return {
      root,
      runtimeRoot,
      dependencies: {
        sourceDirectory: resolve("dist"),
        runtimeRoot,
        homeDirectory,
        runner,
        koocliArtifacts: [],
        runtimePermissions: noopRuntimePermissions,
        approvalProbe: vi.fn(async () => undefined),
      },
    };
  }

  it("installs every installable host into one state and reverifies it", async () => {
    const { runtimeRoot, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["install", "--json"], dependencies)).resolves.toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "installed",
      changed: true,
      hosts: ["codex", "opencode"],
    });
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: {
        hosts: [
          { id: "codex" },
          { id: "opencode" },
        ],
      },
    });

    const stateBefore = await readFile(installStatePath(runtimeRoot));
    await expect(main(["install", "--json"], dependencies)).resolves.toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "unchanged",
      changed: false,
      hosts: ["codex", "opencode"],
    });
    expect(await readFile(installStatePath(runtimeRoot))).toEqual(stateBefore);
    expect(dependencies.approvalProbe).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("upgrades every managed host with one final state and pointer", async () => {
    const { root, runtimeRoot, dependencies } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install"], dependencies);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.1-test");

    await expect(main(["install", "--json"], {
      ...dependencies,
      sourceDirectory: candidateSource,
    })).resolves.toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "upgraded",
      changed: true,
      hosts: ["codex", "opencode"],
      previousVersion: "0.0.0-development",
      pluginVersion: "0.0.1-test",
    });
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: {
        pluginVersion: "0.0.1-test",
        hosts: [{ id: "codex" }, { id: "opencode" }],
      },
    });
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      pluginVersion: "0.0.1-test",
    });
    expect(await readMultiHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("coordinates Codex, Claude, OpenCode and CodeArts in one upgrade", async () => {
    const { root, runtimeRoot, dependencies } = await allHostFixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install"], dependencies);
    const oldState = (await readInstallState(runtimeRoot))!;
    const oldActive = (await readActiveRuntimeSnapshot(runtimeRoot))!;
    expect(oldState.state.hosts.map((host) => host.id))
      .toEqual(["claude", "codearts", "codex", "opencode"]);
    const candidateSource = resolve(root, "all-host-candidate");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.4-test");

    await expect(main(["install", "--json"], {
      ...dependencies,
      sourceDirectory: candidateSource,
    })).resolves.toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "upgraded",
      hosts: ["claude", "codearts", "codex", "opencode"],
      pluginVersion: "0.0.4-test",
    });
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: {
        pluginVersion: "0.0.4-test",
        hosts: [
          {
            id: "claude",
            registration: {
              pluginVersion: "0.0.4-test",
              activation: { version: "0.0.4-test" },
            },
          },
          { id: "codearts" },
          { id: "codex" },
          { id: "opencode" },
        ],
      },
    });
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      pluginVersion: "0.0.4-test",
    });
    expect(await readMultiHostUpgradeRecovery(runtimeRoot)).toBeUndefined();

    const committed = (await readInstallState(runtimeRoot))!;
    const committedActive = (await readActiveRuntimeSnapshot(runtimeRoot))!;
    const claude = committed.state.hosts[0]!;
    const codex = committed.state.hosts[2]!;
    if (
      claude.registration?.kind !== "claude-local-marketplace" ||
      codex.registration?.kind !== "codex-personal-marketplace"
    ) {
      throw new Error("Expected committed plugin host evidence");
    }
    await replaceMultiHostUpgradeRecovery(runtimeRoot, {
      schemaVersion: 1,
      oldStateSha256: oldState.sha256,
      oldPluginVersion: oldState.state.pluginVersion,
      oldInstallManifestSha256: oldState.state.installManifestSha256,
      oldActiveRuntimeSha256: oldActive.sha256,
      candidatePluginVersion: committed.state.pluginVersion,
      candidateInstallManifestSha256: committed.state.installManifestSha256,
      candidateActiveRuntimeSha256: committedActive.sha256,
      hosts: [
        {
          id: "claude",
          candidateAssetTreeHash: claude.asset.installedTreeHash,
          candidateCatalogSha256: claude.registration.installedSha256,
          claudeActivation: {
            pluginId: claude.registration.activation.pluginId,
            version: claude.registration.activation.version,
            installPath: claude.registration.activation.installPath,
            installedEntryHash:
              claude.registration.activation.installedEntryHash,
          },
        },
        {
          id: "codearts",
          candidateAssetTreeHash:
            committed.state.hosts[1]!.asset.installedTreeHash,
        },
        {
          id: "codex",
          candidateAssetTreeHash: codex.asset.installedTreeHash,
          codexActivation: {
            pluginId: codex.registration.activation.pluginId,
            version: codex.registration.activation.version,
            installedEntryHash:
              codex.registration.activation.installedEntryHash,
          },
        },
        {
          id: "opencode",
          candidateAssetTreeHash:
            committed.state.hosts[3]!.asset.installedTreeHash,
        },
      ],
    }, null);
    await expect(recoverInterruptedMultiHostUpgrade(
      runtimeRoot,
      dependencies.homeDirectory!,
      dependencies.runner!,
    )).resolves.toBe("completed");
    expect(await readMultiHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
  }, 45_000);

  it("rolls every host, pointer and state back when final verification fails", async () => {
    const { root, runtimeRoot, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install"], dependencies);
    const stateBefore = await readInstallState(runtimeRoot);
    const activeBefore = await readActiveRuntimeSnapshot(runtimeRoot);
    const candidateSource = resolve(root, "candidate-failure-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.2-test");
    vi.mocked(dependencies.approvalProbe!).mockRejectedValueOnce(
      new Error("Injected approval failure"),
    );

    await expect(main(["install"], {
      ...dependencies,
      sourceDirectory: candidateSource,
    })).rejects.toMatchObject({ code: "HOST_VERIFICATION_FAILED" });
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: {
        pluginVersion: stateBefore?.state.pluginVersion,
        installManifestSha256: stateBefore?.state.installManifestSha256,
        hosts: [
          {
            id: "codex",
            asset: {
              installedTreeHash:
                stateBefore?.state.hosts[0]?.asset.installedTreeHash,
            },
          },
          {
            id: "opencode",
            asset: {
              installedTreeHash:
                stateBefore?.state.hosts[1]?.asset.installedTreeHash,
            },
          },
        ],
      },
    });
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      sha256: activeBefore?.sha256,
      pluginVersion: activeBefore?.pluginVersion,
    });
    expect(await readMultiHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("recovers a recorded candidate asset and activation after interruption", async () => {
    const { root, runtimeRoot, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["install"], dependencies);
    const old = (await readInstallState(runtimeRoot))!;
    const active = (await readActiveRuntimeSnapshot(runtimeRoot))!;
    const candidateSource = resolve(root, "candidate-interrupted-source");
    await copyRuntimeCandidate(resolve("dist"), candidateSource, "0.0.3-test");
    const candidate = await materializeRuntimeCandidate({
      sourceDirectory: candidateSource,
      runtimeRoot,
    });
    const registry = await HostTemplateRegistry.load(
      pathToFileURL(`${resolve(candidate.versionDirectory, "hosts", "templates")}${sep}`),
      pathToFileURL(`${resolve(candidate.versionDirectory, "contracts", "schema")}${sep}`),
    );
    const codexPlan = createHostInstallPlan(
      registry.get("codex"),
      candidate,
      process.platform as "win32" | "darwin" | "linux",
      dependencies.homeDirectory!,
    );
    const opencodePlan = createHostInstallPlan(
      registry.get("opencode"),
      candidate,
      process.platform as "win32" | "darwin" | "linux",
      dependencies.homeDirectory!,
    );
    const codexState = old.state.hosts.find((host) => host.id === "codex")!;
    const bound = await bindCodexInstallation({
      runtimeRoot,
      homeDirectory: dependencies.homeDirectory,
      runner,
      requireExecutable: true,
      snapshot: {
        sha256: old.sha256,
        state: { ...old.state, hosts: [codexState] },
      },
    });
    await rollbackCodexPluginActivation(bound.activationChange, runner);
    await rollbackHostAssetChange(bound.assetChange);
    const candidateAsset = await materializeHostAssets(codexPlan, candidate);
    const candidateActivation = await applyCodexPluginActivation(
      bound.registrationChange.marketplaceName,
      runner,
    );
    await replaceMultiHostUpgradeRecovery(runtimeRoot, {
      schemaVersion: 1,
      oldStateSha256: old.sha256,
      oldPluginVersion: old.state.pluginVersion,
      oldInstallManifestSha256: old.state.installManifestSha256,
      oldActiveRuntimeSha256: active.sha256,
      candidatePluginVersion: candidate.pluginVersion,
      candidateInstallManifestSha256: candidate.installManifestSha256,
      hosts: [
        {
          id: "codex",
          candidateAssetTreeHash: candidateAsset.installedTreeHash,
          codexActivation: {
            pluginId: candidateActivation.pluginId,
            version: candidateActivation.version,
            installedEntryHash: candidateActivation.installedEntryHash,
          },
        },
        {
          id: "opencode",
          candidateAssetTreeHash: await expectedHostAssetTreeHash(
            opencodePlan,
            candidate,
          ),
        },
      ],
    }, null);

    await expect(recoverInterruptedMultiHostUpgrade(
      runtimeRoot,
      dependencies.homeDirectory!,
      runner,
    )).resolves.toBe("rolled-back");
    expect(await readInstallState(runtimeRoot)).toMatchObject({
      state: {
        pluginVersion: old.state.pluginVersion,
        hosts: [{ id: "codex" }, { id: "opencode" }],
      },
    });
    expect(await readActiveRuntimeSnapshot(runtimeRoot)).toMatchObject({
      sha256: active.sha256,
      pluginVersion: active.pluginVersion,
    });
    expect(await readMultiHostUpgradeRecovery(runtimeRoot)).toBeUndefined();
  }, 30_000);

  it("fails closed when no supported host is detected", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-no-host-"));
    roots.push(root);
    const dependencies: CliDependencies = {
      sourceDirectory: resolve("dist"),
      runtimeRoot: resolve(root, "runtime"),
      homeDirectory: resolve(root, "home"),
      runner: new NoHostRunner(),
      koocliArtifacts: [],
      runtimePermissions: noopRuntimePermissions,
      approvalProbe: vi.fn(async () => undefined),
    };

    await expect(main(["install"], dependencies)).rejects.toMatchObject({
      code: "HOST_DISCOVERY_FAILED",
    });
    await expect(readFile(installStatePath(dependencies.runtimeRoot!)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
