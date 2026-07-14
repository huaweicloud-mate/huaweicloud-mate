import { resolve } from "node:path";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";

export interface FakeCodexInstalledEntry extends Record<string, unknown> {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  source: unknown;
  installPolicy: string;
  authPolicy: string;
}

function result(code: number, stdout: string): HostCommandResult {
  return { code, signal: null, stdout, stderr: "" };
}

export function codexInstalledEntry(
  overrides: Partial<FakeCodexInstalledEntry> = {},
): FakeCodexInstalledEntry {
  return {
    pluginId: "huaweicloud-mate@personal",
    name: "huaweicloud-mate",
    marketplaceName: "personal",
    version: "local",
    installed: true,
    enabled: true,
    source: { source: "local", path: "./plugins/huaweicloud-mate" },
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    ...overrides,
  };
}

export class FakeCodexPluginRunner implements HostCommandRunner {
  readonly executablePath: string;
  readonly invocations: string[] = [];
  installedEntry: FakeCodexInstalledEntry | undefined;
  addCode = 0;
  removeCode = 0;
  addMutates = true;
  removeMutates = true;
  resolveAvailable = true;
  readonly failingListCalls = new Set<number>();
  private listCallCount = 0;

  constructor(root: string, installedEntry?: FakeCodexInstalledEntry) {
    this.executablePath = resolve(root, "fake-bin", "codex.exe");
    this.installedEntry = installedEntry;
  }

  async resolveCommand(command: string): Promise<string | undefined> {
    return command === "codex" && this.resolveAvailable
      ? this.executablePath
      : undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    if (executablePath !== this.executablePath) {
      throw new Error("Unexpected executable path");
    }
    const invocation = args.join(" ");
    this.invocations.push(invocation);
    if (invocation === "plugin list --marketplace personal --json") {
      this.listCallCount += 1;
      if (this.failingListCalls.has(this.listCallCount)) {
        throw new Error("Injected list failure");
      }
      return result(
        0,
        `${JSON.stringify({
          installed: this.installedEntry === undefined
            ? []
            : [this.installedEntry],
          available: [],
        })}\n`,
      );
    }
    if (invocation === "plugin add huaweicloud-mate@personal --json") {
      if (this.addMutates) {
        this.installedEntry = codexInstalledEntry();
      }
      return result(this.addCode, "{}\n");
    }
    if (invocation === "plugin remove huaweicloud-mate@personal --json") {
      if (this.removeMutates) {
        this.installedEntry = undefined;
      }
      return result(this.removeCode, "{}\n");
    }
    throw new Error(`Unexpected Codex invocation: ${invocation}`);
  }
}
