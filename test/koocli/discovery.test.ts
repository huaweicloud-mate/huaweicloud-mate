import { describe, expect, it } from "vitest";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { discoverKooCli } from "../../src/koocli/discovery.js";

class FakeRunner implements HostCommandRunner {
  constructor(
    private readonly path: string | undefined,
    private readonly result: HostCommandResult = {
      code: 0,
      signal: null,
      stdout: "KooCLI version 7.2.2",
      stderr: "",
    },
  ) {}

  async resolveCommand(command: string): Promise<string | undefined> {
    expect(command).toBe("hcloud");
    return this.path;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    expect(executablePath).toBe(this.path);
    expect(args).toEqual(["version"]);
    return this.result;
  }
}

describe("KooCLI discovery", () => {
  it("accepts the pinned minimum and compatible 7.x versions", async () => {
    await expect(discoverKooCli(new FakeRunner("C:\\hcloud.exe"))).resolves.toEqual({
      status: "compatible",
      compatible: true,
      executablePath: "C:\\hcloud.exe",
      version: "7.2.2",
    });
    await expect(discoverKooCli(new FakeRunner("/opt/hcloud", {
      code: 0,
      signal: null,
      stdout: "hcloud 7.9.0",
      stderr: "",
    }))).resolves.toMatchObject({ status: "compatible", version: "7.9.0" });
  });

  it("rejects old, future-major, ambiguous and failed versions", async () => {
    await expect(discoverKooCli(new FakeRunner("/hcloud", {
      code: 0,
      signal: null,
      stdout: "7.2.1",
      stderr: "",
    }))).resolves.toMatchObject({ status: "incompatible" });
    await expect(discoverKooCli(new FakeRunner("/hcloud", {
      code: 0,
      signal: null,
      stdout: "8.0.0",
      stderr: "",
    }))).resolves.toMatchObject({ status: "incompatible" });
    await expect(discoverKooCli(new FakeRunner("/hcloud", {
      code: 0,
      signal: null,
      stdout: "7.2.2 -> 7.3.0",
      stderr: "",
    }))).resolves.toMatchObject({ status: "unhealthy" });
    await expect(discoverKooCli(new FakeRunner("/hcloud", {
      code: 1,
      signal: null,
      stdout: "",
      stderr: "failed",
    }))).resolves.toMatchObject({ status: "unhealthy" });
  });

  it("reports a missing executable without running anything", async () => {
    await expect(discoverKooCli(new FakeRunner(undefined))).resolves.toEqual({
      status: "unavailable",
      compatible: false,
    });
  });
});
