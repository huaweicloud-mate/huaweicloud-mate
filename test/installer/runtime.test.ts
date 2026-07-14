import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { InstallerError } from "../../src/installer/errors.js";
import {
  activateMaterializedRuntime,
  materializeRuntimeCandidate,
  materializeStableRuntime,
  readActiveRuntimeSnapshot,
  rollbackActiveRuntimeChange,
} from "../../src/installer/runtime.js";
import { copyRuntimeCandidate } from "../fixtures/runtime-candidate.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-"));
  temporaryRoots.push(root);
  return root;
}

async function launch(
  launcherPath: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [launcherPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("exit", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("versioned stable runtime", () => {
  it("materializes a verified version and launches it through current", async () => {
    const root = await temporaryRoot();
    const runtimeRoot = resolve(root, "runtime");
    const installed = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });

    expect(installed).toMatchObject({
      pluginVersion: "0.0.0-development",
      runtimeRoot,
      reusedVersion: false,
      nodePath: process.execPath,
    });
    expect(installed.installManifestSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect((await lstat(installed.versionDirectory)).isDirectory()).toBe(true);
    expect((await lstat(installed.stableLauncherPath)).isFile()).toBe(true);
    const result = await launch(installed.stableLauncherPath, ["version"]);
    expect(result).toEqual({
      code: 0,
      stdout: "0.0.0-development\n",
      stderr: "",
    });
    await expect(
      launch(
        resolve(
          installed.versionDirectory,
          "approval",
          "companion-process.js",
        ),
        [],
      ),
    ).resolves.toEqual({ code: 2, stdout: "", stderr: "" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [installed.stableLauncherPath, "router", "--stdio"],
      stderr: "pipe",
    });
    const client = new Client(
      { name: "stable-runtime-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "cloud_action_execute",
        "cloud_capabilities_search",
        "cloud_capability_describe",
      ]);
    } finally {
      await client.close();
    }

    const repeated = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    expect(repeated.reusedVersion).toBe(true);
    expect(repeated.versionDirectory).toBe(installed.versionDirectory);
  }, 15_000);

  it("fails closed when an active runtime artifact is modified", async () => {
    const root = await temporaryRoot();
    const installed = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot: resolve(root, "runtime"),
    });
    await writeFile(
      resolve(installed.versionDirectory, "runtime", "cli.js"),
      "tampered\n",
    );

    await expect(
      materializeStableRuntime({
        sourceDirectory: resolve("dist"),
        runtimeRoot: installed.runtimeRoot,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_CONFLICT" });

    const result = await launch(installed.stableLauncherPath, ["version"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "huaweicloud-mate stable runtime verification failed\n",
    );
  });

  it("atomically activates a verified new version and keeps the previous version", async () => {
    const root = await temporaryRoot();
    const runtimeRoot = resolve(root, "runtime");
    const installed = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    const candidate = resolve(root, "candidate-source");
    await copyRuntimeCandidate(resolve("dist"), candidate, "0.0.1-test");

    const upgraded = await materializeStableRuntime({
      sourceDirectory: candidate,
      runtimeRoot,
    });
    expect(upgraded).toMatchObject({
      pluginVersion: "0.0.1-test",
      reusedVersion: false,
      stableLauncherPath: installed.stableLauncherPath,
    });
    expect((await lstat(installed.versionDirectory)).isDirectory()).toBe(true);
    expect(
      JSON.parse(await readFile(upgraded.activeRuntimePath, "utf8")),
    ).toMatchObject({ pluginVersion: "0.0.1-test" });
    await expect(
      launch(upgraded.stableLauncherPath, ["doctor", "--contracts-only"]),
    ).resolves.toMatchObject({ code: 0, stderr: "" });
  }, 15_000);

  it("stages a candidate without switching current and can roll back its CAS activation", async () => {
    const root = await temporaryRoot();
    const runtimeRoot = resolve(root, "runtime");
    const installed = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    const activeBefore = await readActiveRuntimeSnapshot(runtimeRoot);
    const candidateSource = resolve(root, "candidate-source");
    await copyRuntimeCandidate(
      resolve("dist"),
      candidateSource,
      "0.0.1-test",
    );

    const candidate = await materializeRuntimeCandidate({
      sourceDirectory: candidateSource,
      runtimeRoot,
    });
    expect(await readFile(installed.activeRuntimePath, "utf8")).toEqual(
      Buffer.from(activeBefore!.bytes).toString("utf8"),
    );
    await expect(
      launch(installed.stableLauncherPath, ["version"]),
    ).resolves.toMatchObject({ code: 0, stdout: "0.0.0-development\n" });

    await expect(
      activateMaterializedRuntime(
        candidate,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_VERSION_CONFLICT" });
    await expect(
      launch(installed.stableLauncherPath, ["version"]),
    ).resolves.toMatchObject({ code: 0, stdout: "0.0.0-development\n" });

    const change = await activateMaterializedRuntime(
      candidate,
      activeBefore!.sha256,
    );
    await expect(
      launch(installed.stableLauncherPath, ["version"]),
    ).resolves.toMatchObject({ code: 0, stdout: "0.0.1-test\n" });
    await rollbackActiveRuntimeChange(change);
    await expect(rollbackActiveRuntimeChange(change)).resolves.toBeUndefined();
    await expect(
      launch(installed.stableLauncherPath, ["version"]),
    ).resolves.toMatchObject({ code: 0, stdout: "0.0.0-development\n" });
  }, 15_000);

  it("does not switch current when a candidate package fails verification", async () => {
    const root = await temporaryRoot();
    const runtimeRoot = resolve(root, "runtime");
    const installed = await materializeStableRuntime({
      sourceDirectory: resolve("dist"),
      runtimeRoot,
    });
    const activeBefore = await readFile(installed.activeRuntimePath, "utf8");
    const invalidSource = resolve(root, "invalid-source");
    await copyRuntimeCandidate(resolve("dist"), invalidSource, "0.0.1-test");
    await writeFile(
      resolve(invalidSource, "runtime", "cli.js"),
      "invalid candidate\n",
    );

    await expect(
      materializeStableRuntime({ sourceDirectory: invalidSource, runtimeRoot }),
    ).rejects.toBeInstanceOf(InstallerError);
    expect(await readFile(installed.activeRuntimePath, "utf8")).toBe(activeBefore);
    await expect(launch(installed.stableLauncherPath, ["version"])).resolves.toMatchObject({
      code: 0,
      stdout: "0.0.0-development\n",
    });
  });
});
