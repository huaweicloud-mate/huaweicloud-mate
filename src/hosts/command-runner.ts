import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  resolve,
} from "node:path";

import { InstallerError } from "../installer/errors.js";

const commandNamePattern = /^[A-Za-z0-9._-]+$/u;
const maxCommandOutputBytes = 1024 * 1024;
const defaultCommandTimeoutMs = 15_000;

export interface HostCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostCommandRunner {
  resolveCommand(command: string): Promise<string | undefined>;
  run(
    executablePath: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<HostCommandResult>;
}

function failed(message: string): never {
  throw new InstallerError("HOST_VERIFICATION_FAILED", message);
}

function executableExtensions(command: string): readonly string[] {
  if (process.platform !== "win32" || extname(command) !== "") {
    return [""];
  }
  const directlyExecutable = new Set([".com", ".exe"]);
  const configured = process.env.PATHEXT
    ?.split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => directlyExecutable.has(extension));
  return configured === undefined || configured.length === 0
    ? [...directlyExecutable]
    : configured;
}

async function regularExecutable(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    const entry = await lstat(canonicalPath);
    return entry.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

export class NodeHostCommandRunner implements HostCommandRunner {
  async resolveCommand(command: string): Promise<string | undefined> {
    if (!commandNamePattern.test(command)) {
      return failed("Host detection command name is invalid");
    }
    const pathEntries = (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
      .filter((entry) => entry.length > 0 && isAbsolute(entry))
      .slice(0, 256);
    for (const entry of pathEntries) {
      for (const extension of executableExtensions(command)) {
        const candidate = resolve(entry, `${command}${extension}`);
        const executable = await regularExecutable(candidate);
        if (executable !== undefined) {
          return executable;
        }
      }
    }
    return undefined;
  }

  async run(
    executablePath: string,
    args: readonly string[],
    timeoutMs = defaultCommandTimeoutMs,
  ): Promise<HostCommandResult> {
    if (
      !isAbsolute(executablePath) ||
      args.some((argument) => typeof argument !== "string") ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 5 * 60_000
    ) {
      return failed("Host verification command is invalid");
    }
    return await new Promise<HostCommandResult>((resolveResult, rejectResult) => {
      const child = spawn(executablePath, [...args], {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let exceeded = false;
      let timer: NodeJS.Timeout | undefined;
      const finishError = (message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        rejectResult(new InstallerError("HOST_VERIFICATION_FAILED", message));
      };
      timer = setTimeout(() => {
        child.kill();
        finishError("Host verification command timed out");
      }, timeoutMs);
      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxCommandOutputBytes) {
          exceeded = true;
          child.kill();
          return;
        }
        if (target === "stdout") {
          stdout += chunk.toString("utf8");
        } else {
          stderr += chunk.toString("utf8");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", () => {
        finishError("Host verification command could not be started");
      });
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (exceeded) {
          finishError("Host verification command output exceeded the limit");
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveResult({ code, signal, stdout, stderr });
      });
    });
  }
}
