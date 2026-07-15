import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  validateKooCliArtifactBinding,
} from "../../src/koocli/artifacts.js";
import {
  installPrivateKooCli,
  type KooCliArtifactFetcher,
} from "../../src/koocli/installer.js";
import { releasedKooCliArtifacts } from "../../src/koocli/release-artifacts.js";
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

function binding(archive: Uint8Array): KooCliArtifactBinding {
  const platform = currentKooCliPlatform();
  return {
    platform,
    version: pinnedPrivateKooCliVersion,
    archive: platform === "windows-amd64" ? "zip" : "tar.gz",
    url:
      `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/${artifactName(platform)}`,
    sha256: digest(archive),
  };
}

class FakeRunner implements HostCommandRunner {
  async resolveCommand(): Promise<string | undefined> {
    return undefined;
  }

  async run(
    _executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    if (args.join(" ") !== "version") {
      throw new Error("Unexpected KooCLI command");
    }
    return {
      code: 0,
      signal: null,
      stdout: `KooCLI ${pinnedPrivateKooCliVersion}\n`,
      stderr: "",
    };
  }
}

class FakeFetcher implements KooCliArtifactFetcher {
  calls = 0;

  constructor(readonly bytes: Uint8Array) {}

  async fetch(): Promise<Uint8Array> {
    this.calls += 1;
    return this.bytes;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-koocli-"));
  roots.push(root);
  const runtimeRoot = resolve(root, "runtime");
  await mkdir(runtimeRoot);
  const executable = Buffer.from("fake KooCLI executable", "utf8");
  const platform = currentKooCliPlatform();
  const archive = platform === "windows-amd64"
    ? zipSync({ "huaweicloud-cli/hcloud.exe": executable })
    : kooCliTarGz(executable);
  return { runtimeRoot, archive, executable };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("private KooCLI installer", () => {
  it("installs a digest-bound artifact atomically and reuses verified bytes", async () => {
    const { runtimeRoot, archive } = await fixture();
    const fetcher = new FakeFetcher(archive);
    const artifact = binding(archive);
    const runner = new FakeRunner();

    const installed = await installPrivateKooCli({
      runtimeRoot,
      artifact,
      runner,
      fetcher,
    });
    expect(installed).toMatchObject({
      status: "installed",
      version: pinnedPrivateKooCliVersion,
      archiveSha256: artifact.sha256,
    });
    await expect(
      installPrivateKooCli({ runtimeRoot, artifact, runner, fetcher }),
    ).resolves.toMatchObject({
      status: "reused",
      executablePath: installed.executablePath,
      executableSha256: installed.executableSha256,
    });
    expect(fetcher.calls).toBe(1);
  });

  it("rejects drift in a previously installed private executable", async () => {
    const { runtimeRoot, archive } = await fixture();
    const fetcher = new FakeFetcher(archive);
    const artifact = binding(archive);
    const runner = new FakeRunner();
    const installed = await installPrivateKooCli({
      runtimeRoot,
      artifact,
      runner,
      fetcher,
    });
    await writeFile(installed.executablePath, "tampered", "utf8");

    await expect(
      installPrivateKooCli({ runtimeRoot, artifact, runner, fetcher }),
    ).rejects.toMatchObject({ code: "KOOCLI_INSTALL_CONFLICT" });
    expect(fetcher.calls).toBe(1);
  });

  it("rejects a non-approved official object path before downloading", async () => {
    const { runtimeRoot, archive } = await fixture();
    const fetcher = new FakeFetcher(archive);
    const artifact = {
      ...binding(archive),
      url:
        `https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/${pinnedPrivateKooCliVersion}/${artifactName(currentKooCliPlatform())}`,
    };

    expect(() => validateKooCliArtifactBinding(artifact)).toThrowError(
      expect.objectContaining({ code: "KOOCLI_ARTIFACT_INVALID" }),
    );
    await expect(
      installPrivateKooCli({
        runtimeRoot,
        artifact,
        runner: new FakeRunner(),
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "KOOCLI_ARTIFACT_INVALID" });
    expect(fetcher.calls).toBe(0);
  });

  it("binds one approved digest-pinned artifact for every release platform", () => {
    const validated = releasedKooCliArtifacts.map((artifact) =>
      validateKooCliArtifactBinding(artifact)
    );
    expect(validated).toHaveLength(5);
    expect(new Set(validated.map((artifact) => artifact.platform))).toEqual(
      new Set([
        "windows-amd64",
        "linux-amd64",
        "linux-arm64",
        "mac-amd64",
        "mac-arm64",
      ]),
    );
    expect(validated.every(
      (artifact) => artifact.version === pinnedPrivateKooCliVersion,
    )).toBe(true);
  });

  it("rejects a digest mismatch without creating the target", async () => {
    const { runtimeRoot, archive } = await fixture();
    const fetcher = new FakeFetcher(archive);
    const artifact = {
      ...binding(archive),
      sha256: `sha256:${"0".repeat(64)}`,
    };

    await expect(
      installPrivateKooCli({
        runtimeRoot,
        artifact,
        runner: new FakeRunner(),
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "KOOCLI_INSTALL_CONFLICT" });
  });
});
