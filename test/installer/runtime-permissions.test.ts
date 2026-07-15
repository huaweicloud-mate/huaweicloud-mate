import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  HostCommandResult,
  HostCommandRunner,
} from "../../src/hosts/command-runner.js";
import { NodeHostCommandRunner } from "../../src/hosts/command-runner.js";
import {
  PosixRuntimePermissionPolicy,
  WindowsRuntimePermissionPolicy,
} from "../../src/installer/runtime-permissions.js";

const roots: string[] = [];

class WindowsPermissionRunner implements HostCommandRunner {
  readonly calls: { executablePath: string; args: readonly string[] }[] = [];

  constructor(private readonly failAt?: number) {}

  async resolveCommand(command: string): Promise<string | undefined> {
    return command === "whoami"
      ? "C:\\Windows\\System32\\whoami.exe"
      : command === "icacls"
        ? "C:\\Windows\\System32\\icacls.exe"
        : undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
  ): Promise<HostCommandResult> {
    this.calls.push({ executablePath, args });
    if (executablePath.endsWith("whoami.exe")) {
      return {
        code: 0,
        signal: null,
        stdout: '"desktop\\user","S-1-5-21-1-2-3-1001"\r\n',
        stderr: "",
      };
    }
    return {
      code: this.failAt === this.calls.length ? 5 : 0,
      signal: null,
      stdout: "",
      stderr: "",
    };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe.runIf(process.platform !== "win32")(
  "POSIX runtime permissions",
  () => {
    it("creates a current-user-only runtime root and verifies it", async () => {
      const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-mode-"));
      roots.push(root);
      const runtimeRoot = resolve(root, "runtime");
      const policy = new PosixRuntimePermissionPolicy();

      await policy.secureRoot(runtimeRoot);

      expect((await lstat(runtimeRoot)).mode & 0o777).toBe(0o700);
      await expect(policy.verifyRoot(runtimeRoot)).resolves.toBeUndefined();
    });

    it("rejects a runtime root with group or other access", async () => {
      const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-open-"));
      roots.push(root);
      const policy = new PosixRuntimePermissionPolicy();
      await policy.secureRoot(root);
      const { chmod } = await import("node:fs/promises");
      await chmod(root, 0o755);

      await expect(policy.verifyRoot(root)).rejects.toMatchObject({
        code: "RUNTIME_PERMISSIONS_FAILED",
      });
    });
  },
);

describe("Windows runtime permissions", () => {
  it("applies and rechecks one recursive current-user ACL", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-acl-"));
    roots.push(root);
    const runtimeRoot = resolve(root, "runtime");
    const runner = new WindowsPermissionRunner();
    const policy = new WindowsRuntimePermissionPolicy(runner);

    await policy.secureRoot(runtimeRoot);
    await policy.verifyRoot(runtimeRoot);

    expect(runner.calls.filter((call) => call.executablePath.endsWith("whoami.exe")))
      .toHaveLength(1);
    const aclCalls = runner.calls
      .filter((call) => call.executablePath.endsWith("icacls.exe"))
      .map((call) => call.args);
    expect(aclCalls).toHaveLength(8);
    expect(aclCalls.slice(0, 4)).toEqual([
      [runtimeRoot, "/reset", "/t", "/c", "/q", "/l"],
      [runtimeRoot, "/inheritance:r", "/t", "/c", "/q", "/l"],
      [runtimeRoot, "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)(F)", "/t", "/c", "/q", "/l"],
      [runtimeRoot, "/findsid", "*S-1-5-21-1-2-3-1001", "/t", "/c", "/q", "/l"],
    ]);
  });

  it("fails closed when the recursive ACL cannot be applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-acl-fail-"));
    roots.push(root);
    const runner = new WindowsPermissionRunner(3);
    const policy = new WindowsRuntimePermissionPolicy(runner);

    await expect(policy.secureRoot(resolve(root, "runtime"))).rejects.toMatchObject({
      code: "RUNTIME_PERMISSIONS_FAILED",
    });
  });

  it("rejects a non-directory before invoking ACL tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-file-"));
    roots.push(root);
    const path = resolve(root, "runtime");
    await writeFile(path, "not a directory");
    const runner = new WindowsPermissionRunner();
    const policy = new WindowsRuntimePermissionPolicy(runner);

    await expect(policy.verifyRoot(path)).rejects.toMatchObject({
      code: "RUNTIME_PERMISSIONS_FAILED",
    });
    expect(runner.calls).toHaveLength(0);
  });
});

describe.runIf(process.platform === "win32")(
  "Windows runtime permissions integration",
  () => {
    it("secures and verifies an actual temporary runtime tree", async () => {
      const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-runtime-acl-real-"));
      roots.push(root);
      const runtimeRoot = resolve(root, "runtime");
      const policy = new WindowsRuntimePermissionPolicy(new NodeHostCommandRunner());

      await policy.secureRoot(runtimeRoot);
      await writeFile(resolve(runtimeRoot, "recovery.json"), "{}\n");

      await expect(policy.verifyRoot(runtimeRoot)).resolves.toBeUndefined();
    });
  },
);
