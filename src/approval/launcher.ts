import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createExpectedApprovalBinding } from "./binding.js";
import {
  maxApprovalClockSkewMs,
} from "./constants.js";
import { ApprovalError } from "./errors.js";
import {
  createApprovalReviewMessage,
  parseApprovalResultMessage,
  parseApprovalSessionReadyMessage,
  type ApprovalResultMessage,
} from "./session-protocol.js";
import type {
  ApprovalReceipt,
  ApprovalSessionBinding,
  ApprovalSigningContext,
} from "./types.js";
import { TrustedApprovalVerifier } from "./verifier.js";

interface RuntimeManifest {
  readonly schemaVersion: "huaweicloud-mate-runtime-manifest/v1";
  readonly approvalCompanion: {
    readonly entryPath: "approval/companion-process.js";
    readonly artifacts: readonly RuntimeArtifact[];
  };
}

interface RuntimeArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface ApprovalCompanionLauncherOptions {
  readonly entryPath: string;
  readonly expectedSha256: string;
  readonly artifacts?: readonly {
    readonly path: string;
    readonly expectedSha256: string;
  }[];
  readonly contractDirectory?: URL;
  readonly timeoutMs?: number;
}

const allowedCompanionEnvironmentKeys = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "Path",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
] as const;
const maxApprovalIpcMessageBytes = 65_536;

function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest is not an object",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\n") !==
      ["approvalCompanion", "schemaVersion"].join("\n") ||
    record.schemaVersion !== "huaweicloud-mate-runtime-manifest/v1" ||
    typeof record.approvalCompanion !== "object" ||
    record.approvalCompanion === null ||
    Array.isArray(record.approvalCompanion)
  ) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest is invalid",
    );
  }
  const companion = record.approvalCompanion as Record<string, unknown>;
  if (
    Object.keys(companion).sort().join("\n") !==
      ["artifacts", "entryPath"].join("\n") ||
    companion.entryPath !== "approval/companion-process.js" ||
    !Array.isArray(companion.artifacts)
  ) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Approval companion manifest entry is invalid",
    );
  }
  const seenPaths = new Set<string>();
  const artifacts = companion.artifacts.map((value): RuntimeArtifact => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Runtime artifact entry is not an object",
      );
    }
    const artifact = value as Record<string, unknown>;
    if (
      Object.keys(artifact).sort().join("\n") !== ["path", "sha256"].join("\n") ||
      typeof artifact.path !== "string" ||
      !/^(?:approval\/[A-Za-z0-9._-]+\.js|contracts\/(?:manifest|registry)\.js|contracts\/schema\/[A-Za-z0-9._-]+\.json)$/.test(
        artifact.path,
      ) ||
      seenPaths.has(artifact.path) ||
      typeof artifact.sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Runtime artifact entry is invalid",
      );
    }
    seenPaths.add(artifact.path);
    return { path: artifact.path, sha256: artifact.sha256 };
  });
  if (
    artifacts.length === 0 ||
    !seenPaths.has("approval/companion-process.js")
  ) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest does not bind the approval companion entry",
    );
  }
  return {
    schemaVersion: "huaweicloud-mate-runtime-manifest/v1",
    approvalCompanion: {
      entryPath: "approval/companion-process.js",
      artifacts,
    },
  };
}

function minimalCompanionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedCompanionEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function sha256File(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

export class ApprovalCompanionLauncher {
  readonly #entryPath: string;
  readonly #contractDirectory: URL | undefined;
  readonly #timeoutMs: number;
  readonly #artifacts: readonly {
    readonly path: string;
    readonly expectedSha256: string;
  }[];

  constructor(options: ApprovalCompanionLauncherOptions) {
    if (!isAbsolute(options.entryPath)) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval companion entry path must be absolute",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(options.expectedSha256)) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval companion digest is invalid",
      );
    }
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
      throw new ApprovalError(
        "APPROVAL_PROCESS_TIMEOUT",
        "Approval companion timeout must be between 1 and 300 seconds",
      );
    }
    const artifacts = options.artifacts ?? [
      {
        path: options.entryPath,
        expectedSha256: options.expectedSha256,
      },
    ];
    if (
      artifacts.length === 0 ||
      artifacts.some(
        (artifact) =>
          !isAbsolute(artifact.path) ||
          !/^sha256:[a-f0-9]{64}$/.test(artifact.expectedSha256),
      ) ||
      !artifacts.some(
        (artifact) =>
          artifact.path === options.entryPath &&
          artifact.expectedSha256 === options.expectedSha256,
      )
    ) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval runtime artifact list is invalid",
      );
    }
    this.#entryPath = options.entryPath;
    this.#contractDirectory = options.contractDirectory;
    this.#timeoutMs = timeoutMs;
    this.#artifacts = artifacts;
  }

  static async fromRuntimeManifest(
    manifestUrl = new URL("../runtime-manifest.json", import.meta.url),
    contractDirectory?: URL,
  ): Promise<ApprovalCompanionLauncher> {
    const manifest = parseRuntimeManifest(
      JSON.parse(await readFile(manifestUrl, "utf8")) as unknown,
    );
    const runtimeDirectory = dirname(fileURLToPath(manifestUrl));
    const entryPath = resolve(
      runtimeDirectory,
      manifest.approvalCompanion.entryPath,
    );
    return new ApprovalCompanionLauncher({
      entryPath,
      expectedSha256:
        manifest.approvalCompanion.artifacts.find(
          (artifact) => artifact.path === manifest.approvalCompanion.entryPath,
        )?.sha256 ?? "",
      artifacts: manifest.approvalCompanion.artifacts.map((artifact) => ({
        path: resolve(runtimeDirectory, artifact.path),
        expectedSha256: artifact.sha256,
      })),
      ...(contractDirectory === undefined ? {} : { contractDirectory }),
    });
  }

  async review(context: ApprovalSigningContext): Promise<ApprovalReceipt | null> {
    let reviewSize: number;
    try {
      reviewSize = Buffer.byteLength(
        JSON.stringify(createApprovalReviewMessage(context)),
        "utf8",
      );
    } catch {
      throw new ApprovalError(
        "APPROVAL_REQUEST_INVALID",
        "Approval context is not serializable",
      );
    }
    if (reviewSize > maxApprovalIpcMessageBytes) {
      throw new ApprovalError(
        "APPROVAL_REQUEST_INVALID",
        "Approval context exceeds the private IPC limit",
      );
    }
    await this.#verifyArtifact();
    const child = this.#spawnCompanion();
    return this.#exchange(child, context);
  }

  async #verifyArtifact(): Promise<void> {
    for (const artifact of this.#artifacts) {
      if (!isAbsolute(artifact.path)) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact path must be absolute",
        );
      }
      const entry = await lstat(artifact.path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact must be a regular non-symlink file",
        );
      }
      if ((await sha256File(artifact.path)) !== artifact.expectedSha256) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact digest does not match the runtime manifest",
        );
      }
    }
  }

  #spawnCompanion(): ChildProcess {
    return fork(this.#entryPath, [], {
      cwd: dirname(this.#entryPath),
      detached: false,
      env: minimalCompanionEnvironment(),
      execArgv: [],
      execPath: process.execPath,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  }

  #exchange(
    child: ChildProcess,
    context: ApprovalSigningContext,
  ): Promise<ApprovalReceipt | null> {
    return new Promise<ApprovalReceipt | null>((resolveResult, rejectResult) => {
      let settled = false;
      let readyBinding: ApprovalSessionBinding | undefined;
      let verifier: Promise<TrustedApprovalVerifier> | undefined;
      let messageChain = Promise.resolve();
      const startedAt = Date.now();

      const cleanup = (terminate: boolean): void => {
        clearTimeout(timeout);
        if (child.connected) {
          child.disconnect();
        }
        if (terminate && child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(true);
        rejectResult(
          error instanceof ApprovalError
            ? error
            : new ApprovalError(
                "APPROVAL_PROCESS_FAILED",
                "Approval companion process failed",
              ),
        );
      };
      const succeed = (receipt: ApprovalReceipt | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup(false);
        resolveResult(receipt);
      };
      const handleResult = async (result: ApprovalResultMessage): Promise<void> => {
        if (readyBinding === undefined || verifier === undefined) {
          if (result.status === "error") {
            throw new ApprovalError(result.code, result.message);
          }
          throw new ApprovalError(
            "APPROVAL_PROTOCOL_INVALID",
            "Approval companion returned a result before session binding",
          );
        }
        if (result.approvalSessionId !== readyBinding.sessionId) {
          throw new ApprovalError(
            "APPROVAL_PROTOCOL_INVALID",
            "Approval result session does not match the ready binding",
          );
        }
        if (result.status === "error") {
          throw new ApprovalError(result.code, result.message);
        }
        if (result.status === "rejected") {
          succeed(null);
          return;
        }

        const receiptVerifier = await verifier;
        receiptVerifier.verifyAndConsume(
          result.receipt,
          createExpectedApprovalBinding(context, readyBinding.sessionId),
          new Date(),
        );
        succeed(result.receipt);
      };
      const handleMessage = async (rawMessage: unknown): Promise<void> => {
        if (readyBinding === undefined) {
          try {
            const ready = parseApprovalSessionReadyMessage(rawMessage);
            const createdAt = Date.parse(ready.binding.createdAt);
            if (
              !Number.isFinite(createdAt) ||
              createdAt < startedAt - maxApprovalClockSkewMs ||
              createdAt > Date.now() + maxApprovalClockSkewMs
            ) {
              throw new ApprovalError(
                "APPROVAL_PROTOCOL_INVALID",
                "Approval session binding is outside the startup time window",
              );
            }
            readyBinding = ready.binding;
            verifier = TrustedApprovalVerifier.create(
              ready.binding,
              this.#contractDirectory,
            );
            return;
          } catch (readyError) {
            let result: ApprovalResultMessage;
            try {
              result = parseApprovalResultMessage(rawMessage);
            } catch {
              throw readyError;
            }
            await handleResult(result);
            return;
          }
        }
        await handleResult(parseApprovalResultMessage(rawMessage));
      };

      const timeout = setTimeout(() => {
        fail(
          new ApprovalError(
            "APPROVAL_PROCESS_TIMEOUT",
            "Approval companion process timed out",
          ),
        );
      }, this.#timeoutMs);
      timeout.unref();

      child.on("message", (rawMessage: unknown) => {
        messageChain = messageChain.then(() => handleMessage(rawMessage));
        void messageChain.catch(fail);
      });
      child.stderr?.resume();
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        void messageChain.then(() => {
          if (!settled) {
            fail(
              new ApprovalError(
                "APPROVAL_PROCESS_FAILED",
                `Approval companion exited before a result (code=${String(code)}, signal=${String(signal)})`,
              ),
            );
          }
        });
      });

      try {
        child.send(createApprovalReviewMessage(context), (error) => {
          if (error !== null && error !== undefined) {
            fail(
              new ApprovalError(
                "APPROVAL_PROCESS_FAILED",
                "Router could not send the approval request over private IPC",
              ),
            );
          }
        });
      } catch {
        fail(
          new ApprovalError(
            "APPROVAL_PROCESS_FAILED",
            "Router could not open the private approval IPC channel",
          ),
        );
      }
    });
  }
}
