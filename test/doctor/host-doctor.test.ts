import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, type CliDependencies } from "../../src/cli.js";
import { runHostDoctor } from "../../src/doctor/host-doctor.js";
import {
  type HostCommandResult,
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { noopRuntimePermissions } from "../fixtures/runtime-permissions.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

class HostDoctorRunner implements HostCommandRunner {
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
        return {
          code: 0,
          signal: null,
          stdout: "huaweicloud-agent connected",
          stderr: "",
        };
      }
      if (args.join(" ") === "debug skill") {
        return {
          code: 0,
          signal: null,
          stdout: "huaweicloud",
          stderr: "",
        };
      }
      return { code: 2, signal: null, stdout: "", stderr: "unexpected" };
    }
    return this.fallback.run(executablePath, args, timeoutMs);
  }
}

describe("host doctor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  async function fixture(): Promise<{
    readonly root: string;
    readonly runtimeRoot: string;
    readonly homeDirectory: string;
    readonly runner: HostDoctorRunner;
    readonly dependencies: CliDependencies;
  }> {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-host-doctor-"));
    roots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    const homeDirectory = resolve(root, "home");
    const runner = new HostDoctorRunner(root);
    return {
      root,
      runtimeRoot,
      homeDirectory,
      runner,
      dependencies: {
        sourceDirectory: resolve("dist"),
        runtimeRoot,
        homeDirectory,
        runner,
        runtimePermissions: noopRuntimePermissions,
        approvalProbe: vi.fn(async () => undefined),
        koocliArtifacts: [],
        contractDirectory,
      },
    };
  }

  it("reports detected but unmanaged hosts without modifying the runtime", async () => {
    const { runtimeRoot, homeDirectory, runner, dependencies } = await fixture();

    await expect(runHostDoctor({
      runtimeRoot,
      homeDirectory,
      runner,
      contractDirectory,
    })).resolves.toMatchObject({
      schemaVersion: "huaweicloud-mate-host-doctor/v1",
      ok: false,
      installState: "absent",
      hosts: [
        { id: "codex", status: "not-detected", managed: false },
        { id: "claude", status: "not-detected", managed: false },
        { id: "opencode", status: "available", managed: false },
        { id: "codearts", status: "not-detected", managed: false },
      ],
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["doctor", "--hosts", "--json"], dependencies))
      .resolves.toBe(1);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      readonly ok: boolean;
      readonly hostReport: { readonly ok: boolean };
    };
    expect(output.ok).toBe(false);
    expect(output.hostReport.ok).toBe(false);
  });

  it("rechecks a managed host and reports asset drift without exposing paths", async () => {
    const { runtimeRoot, homeDirectory, runner, dependencies } = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      main(["install", "--host", "opencode", "--json"], dependencies),
    ).resolves.toBe(0);

    const healthy = await runHostDoctor({
      runtimeRoot,
      homeDirectory,
      runner,
      contractDirectory,
    });
    expect(healthy.ok).toBe(true);
    expect(healthy.installState).toBe("healthy");
    expect(healthy.hosts.find((host) => host.id === "opencode"))
      .toMatchObject({
        id: "opencode",
        status: "managed",
        managed: true,
        checks: expect.arrayContaining(["config", "mcp-process", "skill"]),
      });
    expect(JSON.stringify(healthy)).not.toContain(runtimeRoot);
    expect(JSON.stringify(healthy)).not.toContain(homeDirectory);

    await writeFile(
      resolve(homeDirectory, ".config", "opencode", "skills", "huaweicloud", "SKILL.md"),
      "tampered\n",
      "utf8",
    );
    const drifted = await runHostDoctor({
      runtimeRoot,
      homeDirectory,
      runner,
      contractDirectory,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.installState).toBe("healthy");
    expect(drifted.hosts.find((host) => host.id === "opencode"))
      .toMatchObject({
        id: "opencode",
        status: "drifted",
        managed: true,
        errorCode: "HOST_ASSET_CONFLICT",
      });
  }, 30_000);
});
