import { resolve } from "node:path";

import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../../src/hosts/command-runner.js";

export const claudePluginId =
  "huaweicloud-mate@huaweicloud-mate-local" as const;

export interface ClaudeMarketplaceListEntry extends Record<string, unknown> {
  name: string;
  source: string;
  path: string;
}

export interface ClaudePluginListEntry extends Record<string, unknown> {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
}

function commandResult(code: number, stdout = ""): HostCommandResult {
  return { code, signal: null, stdout, stderr: "" };
}

function cacheRoot(marketplaceRoot: string): string {
  return resolve(marketplaceRoot, "..", "..", "fake-claude-cache");
}

export class FakeClaudeLifecycleRunner implements HostCommandRunner {
  readonly executablePath: string;
  readonly invocations: string[] = [];
  marketplaceEntry: ClaudeMarketplaceListEntry | undefined;
  pluginEntry: ClaudePluginListEntry | undefined;
  marketplaceAddMutates = true;
  marketplaceRemoveMutates = true;
  installMutates = true;
  uninstallMutates = true;
  marketplaceAddCode = 0;
  installCode = 0;
  uninstallCode = 0;
  readonly failingMarketplaceListCalls = new Set<number>();
  readonly failingPluginListCalls = new Set<number>();
  private marketplaceListCallCount = 0;
  private pluginListCallCount = 0;

  constructor(
    root: string,
    readonly marketplaceRoot: string,
    readonly pluginVersion: string,
    private readonly fallback: HostCommandRunner = new NodeHostCommandRunner(),
  ) {
    this.executablePath = resolve(root, "fake-bin", "claude.exe");
  }

  createMarketplaceEntry(
    overrides: Partial<ClaudeMarketplaceListEntry> = {},
  ): ClaudeMarketplaceListEntry {
    return {
      name: "huaweicloud-mate-local",
      source: "directory",
      path: this.marketplaceRoot,
      installLocation: this.marketplaceRoot,
      ...overrides,
    };
  }

  createPluginEntry(
    overrides: Partial<ClaudePluginListEntry> = {},
  ): ClaudePluginListEntry {
    return {
      id: claudePluginId,
      version: this.pluginVersion,
      scope: "user",
      enabled: true,
      installPath: this.pluginInstallPath(this.pluginVersion),
      installedAt: "2026-07-14T00:00:00.000Z",
      lastUpdated: "2026-07-14T00:00:00.000Z",
      ...overrides,
    };
  }

  pluginInstallPath(version: string): string {
    return resolve(
      cacheRoot(this.marketplaceRoot),
      "huaweicloud-mate-local",
      "huaweicloud-mate",
      version,
    );
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    if (command === "claude") {
      return this.executablePath;
    }
    return await this.fallback.resolveCommand(command);
  }

  async run(
    executablePath: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<HostCommandResult> {
    if (executablePath !== this.executablePath) {
      return await this.fallback.run(executablePath, args, timeoutMs);
    }
    const invocation = args.join(" ");
    this.invocations.push(invocation);
    if (invocation === `plugin validate ${this.marketplaceRoot}`) {
      return commandResult(0, "Validation passed\n");
    }
    if (invocation === "plugin marketplace list --json") {
      this.marketplaceListCallCount += 1;
      if (
        this.failingMarketplaceListCalls.has(this.marketplaceListCallCount)
      ) {
        throw new Error("Injected Claude marketplace list failure");
      }
      return commandResult(
        0,
        `${JSON.stringify(
          this.marketplaceEntry === undefined ? [] : [this.marketplaceEntry],
        )}\n`,
      );
    }
    if (
      invocation ===
      `plugin marketplace add ${this.marketplaceRoot} --scope user`
    ) {
      if (this.marketplaceAddMutates) {
        this.marketplaceEntry = this.createMarketplaceEntry();
      }
      return commandResult(this.marketplaceAddCode);
    }
    if (
      invocation === "plugin marketplace remove huaweicloud-mate-local"
    ) {
      if (this.marketplaceRemoveMutates) {
        this.marketplaceEntry = undefined;
      }
      return commandResult(0);
    }
    if (invocation === "plugin list --json") {
      this.pluginListCallCount += 1;
      if (this.failingPluginListCalls.has(this.pluginListCallCount)) {
        throw new Error("Injected Claude plugin list failure");
      }
      return commandResult(
        0,
        `${JSON.stringify(
          this.pluginEntry === undefined ? [] : [this.pluginEntry],
        )}\n`,
      );
    }
    if (
      invocation ===
      `plugin install ${claudePluginId} --scope user`
    ) {
      if (this.installMutates) {
        this.pluginEntry = this.createPluginEntry();
      }
      return commandResult(this.installCode);
    }
    if (
      invocation ===
      `plugin uninstall ${claudePluginId} --scope user --keep-data`
    ) {
      if (this.uninstallMutates) {
        this.pluginEntry = undefined;
      }
      return commandResult(this.uninstallCode);
    }
    throw new Error(`Unexpected Claude invocation: ${invocation}`);
  }
}
