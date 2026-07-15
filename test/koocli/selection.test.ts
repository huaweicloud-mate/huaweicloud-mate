import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import {
  currentKooCliPlatform,
  pinnedPrivateKooCliVersion,
  type KooCliArtifactBinding,
} from "../../src/koocli/artifacts.js";
import type { KooCliArtifactFetcher } from "../../src/koocli/installer.js";
import {
  ensureKooCliAvailable,
  inspectKooCliAvailability,
} from "../../src/koocli/selection.js";
import { kooCliTarGz } from "../fixtures/koocli-archive.js";

const roots: string[] = [];

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactName(platform: KooCliArtifactBinding["platform"]): string {
  return platform === "windows-amd64"
    ? "huaweicloud-cli-windows-amd64.zip"
    : `huaweicloud-cli-${platform}.tar.gz`;
}

class SelectionRunner implements HostCommandRunner {
  constructor(private readonly systemPath?: string) {}

  async resolveCommand(command: string): Promise<string | undefined> {
    expect(command).toBe("hcloud");
    return this.systemPath;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    expect(args).toEqual(["version"]);
    if (this.systemPath !== undefined && executablePath !== this.systemPath) {
      throw new Error("System KooCLI path changed");
    }
    return {
      code: 0,
      signal: null,
      stdout: this.systemPath === undefined
        ? `KooCLI ${pinnedPrivateKooCliVersion}`
        : "KooCLI 7.2.2",
      stderr: "",
    };
  }
}

class Fetcher implements KooCliArtifactFetcher {
  calls = 0;
  constructor(private readonly archive: Uint8Array) {}
  async fetch(): Promise<Uint8Array> {
    this.calls += 1;
    return this.archive;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-koocli-selection-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  await mkdir(runtimeRoot);
  const platform = currentKooCliPlatform();
  const executable = Buffer.from("private KooCLI fixture", "utf8");
  const archive = platform === "windows-amd64"
    ? zipSync({ "bundle/hcloud.exe": executable })
    : kooCliTarGz(executable);
  const artifact: KooCliArtifactBinding = {
    platform,
    version: pinnedPrivateKooCliVersion,
    archive: platform === "windows-amd64" ? "zip" : "tar.gz",
    url:
      `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/${artifactName(platform)}`,
    sha256: digest(archive),
  };
  return { runtimeRoot, archive, artifact };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("KooCLI selection", () => {
  it("prefers a compatible system installation without downloading", async () => {
    const { runtimeRoot, archive, artifact } = await fixture();
    const fetcher = new Fetcher(archive);

    await expect(
      ensureKooCliAvailable(
        runtimeRoot,
        new SelectionRunner(resolve(runtimeRoot, "system", "hcloud")),
        [artifact],
        fetcher,
      ),
    ).resolves.toMatchObject({
      status: "compatible",
      source: "system",
      version: "7.2.2",
    });
    expect(fetcher.calls).toBe(0);
  });

  it("installs and subsequently inspects the private fallback", async () => {
    const { runtimeRoot, archive, artifact } = await fixture();
    const fetcher = new Fetcher(archive);
    const runner = new SelectionRunner();

    await expect(
      inspectKooCliAvailability(runtimeRoot, runner, [artifact]),
    ).resolves.toMatchObject({ status: "private-missing", compatible: false });
    await expect(
      ensureKooCliAvailable(runtimeRoot, runner, [artifact], fetcher),
    ).resolves.toMatchObject({
      status: "compatible",
      source: "private",
      version: pinnedPrivateKooCliVersion,
    });
    await expect(
      inspectKooCliAvailability(runtimeRoot, runner, [artifact]),
    ).resolves.toMatchObject({
      status: "compatible",
      source: "private",
      version: pinnedPrivateKooCliVersion,
    });
    expect(fetcher.calls).toBe(1);
  });

  it("reports the release binding gap explicitly", async () => {
    const { runtimeRoot } = await fixture();
    await expect(
      inspectKooCliAvailability(runtimeRoot, new SelectionRunner(), []),
    ).resolves.toMatchObject({
      status: "binding-missing",
      compatible: false,
      system: { status: "unavailable" },
    });
  });
});
