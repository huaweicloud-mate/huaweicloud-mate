import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
import {
  contractFileNames,
  type ContractFileName,
} from "../contracts/manifest.js";
import type { ContractJsonDocuments } from "../contracts/registry.js";

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
    readonly runtimePath?: string;
  }[];
  readonly contractDirectory?: URL;
  readonly timeoutMs?: number;
  readonly loadVerifiedEntryBytes?: boolean;
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
const maxApprovalArtifactBytes = 64 * 1024 * 1024;
const maxRuntimeManifestBytes = 1024 * 1024;
const verifiedContractDocumentsKey =
  "__HUAWEICLOUD_MATE_VERIFIED_CONTRACT_DOCUMENTS__";
const bootstrapReadyMessage = {
  schemaVersion: "huaweicloud-mate-approval-bootstrap-ready/v1",
  type: "approval-bootstrap-ready",
} as const;
const companionBootstrapSource = String.raw`
const chunks = [];
let byteLength = 0;
let stage = "verify-process";
try {
  const inspector = await import("node:inspector");
  if (
    inspector.url() !== undefined ||
    process.execArgv.some((argument) => /^--(?:inspect|debug)(?:-|=|$)/.test(argument)) ||
    process.env.NODE_OPTIONS !== undefined ||
    process.env.NODE_PATH !== undefined ||
    process.env.NODE_DEBUG !== undefined ||
    process.env.NODE_DEBUG_NATIVE !== undefined ||
    process.env.NODE_V8_COVERAGE !== undefined ||
    process.env.SSLKEYLOGFILE !== undefined
  ) throw new Error("unsafe process");
  stage = "read-envelope";
  for await (const chunk of process.stdin) {
    byteLength += chunk.byteLength;
    if (byteLength <= 0 || byteLength > ${maxApprovalArtifactBytes}) throw new Error("invalid source");
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
    Object.keys(envelope).sort().join("\n") !== "contractDocuments\nentrySource\nschemaVersion" ||
    envelope.schemaVersion !== "huaweicloud-mate-verified-companion/v1" ||
    typeof envelope.entrySource !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.entrySource) ||
    typeof envelope.contractDocuments !== "object" ||
    envelope.contractDocuments === null || Array.isArray(envelope.contractDocuments)
  ) throw new Error("invalid envelope");
  const sourceBytes = Buffer.from(envelope.entrySource, "base64");
  if (
    sourceBytes.byteLength <= 0 || sourceBytes.byteLength > ${maxApprovalArtifactBytes} ||
    sourceBytes.toString("base64") !== envelope.entrySource
  ) throw new Error("invalid source");
  stage = "bind-runtime";
  const logicalUrl = new URL(process.argv[1]);
  if (logicalUrl.protocol !== "file:") throw new Error("invalid logical URL");
  Object.defineProperty(globalThis, "__HUAWEICLOUD_MATE_COMPANION_IMPORT_META_URL__", {
    value: logicalUrl.href,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(globalThis, "${verifiedContractDocumentsKey}", {
    value: Object.freeze({ ...envelope.contractDocuments }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  stage = "import-entry";
  const loaded = await import("data:text/javascript;base64," + envelope.entrySource);
  if (typeof loaded.runApprovalCompanionProcess !== "function") throw new Error("invalid entry");
  stage = "start-entry";
  const pending = loaded.runApprovalCompanionProcess();
  stage = "signal-ready";
  await new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) return reject(new Error("missing IPC"));
    process.send(${JSON.stringify(bootstrapReadyMessage)}, (error) => error == null ? resolve() : reject(error));
  });
  stage = "run-entry";
  process.exitCode = await pending;
} catch {
  try {
    if (process.send !== undefined && process.connected) {
      await new Promise((resolve) => process.send({
        schemaVersion: "huaweicloud-mate-approval-bootstrap-error/v1",
        type: "approval-bootstrap-error",
        stage,
      }, () => resolve()));
    }
  } catch {}
  process.exitCode = 2;
} finally {
  if (process.connected) process.disconnect();
}
`;

function isBootstrapReadyMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === "schemaVersion\ntype" &&
    (value as Record<string, unknown>).schemaVersion ===
      bootstrapReadyMessage.schemaVersion &&
    (value as Record<string, unknown>).type === bootstrapReadyMessage.type
  );
}

function bootstrapErrorStage(value: unknown): string | undefined {
  const allowedStages = new Set([
    "verify-process",
    "read-envelope",
    "bind-runtime",
    "import-entry",
    "start-entry",
    "signal-ready",
    "run-entry",
  ]);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== "schemaVersion\nstage\ntype"
  ) return undefined;
  const record = value as Record<string, unknown>;
  return record.schemaVersion ===
      "huaweicloud-mate-approval-bootstrap-error/v1" &&
      record.type === "approval-bootstrap-error" &&
      typeof record.stage === "string" &&
      allowedStages.has(record.stage)
    ? record.stage
    : undefined;
}

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
    !Array.isArray(companion.artifacts) ||
    companion.artifacts.length === 0 ||
    companion.artifacts.length > 128
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
    !seenPaths.has("approval/companion-process.js") ||
    contractFileNames.some(
      (fileName) => !seenPaths.has(`contracts/schema/${fileName}`),
    )
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

async function readRuntimeManifest(url: URL): Promise<RuntimeManifest> {
  if (url.protocol !== "file:") {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest must be a local file",
    );
  }
  const path = fileURLToPath(url);
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size <= 0 ||
    entry.size > maxRuntimeManifestBytes
  ) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest must be a bounded regular file",
    );
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size) {
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest changed while it was read",
    );
  }
  try {
    return parseRuntimeManifest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    );
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    throw new ApprovalError(
      "APPROVAL_ARTIFACT_INVALID",
      "Runtime manifest is not valid UTF-8 JSON",
    );
  }
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
    readonly runtimePath?: string;
  }[];
  readonly #loadVerifiedEntryBytes: boolean;

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
          !/^sha256:[a-f0-9]{64}$/.test(artifact.expectedSha256) ||
          (artifact.runtimePath !== undefined &&
            !/^(?:approval\/[A-Za-z0-9._-]+\.js|contracts\/(?:manifest|registry)\.js|contracts\/schema\/[A-Za-z0-9._-]+\.json)$/.test(
              artifact.runtimePath,
            )),
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
    const runtimePaths = artifacts
      .map((artifact) => artifact.runtimePath)
      .filter((value): value is string => value !== undefined);
    if (new Set(runtimePaths).size !== runtimePaths.length) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval runtime artifact paths are duplicated",
      );
    }
    this.#entryPath = options.entryPath;
    this.#contractDirectory = options.contractDirectory;
    this.#timeoutMs = timeoutMs;
    this.#artifacts = artifacts;
    this.#loadVerifiedEntryBytes = options.loadVerifiedEntryBytes === true;
  }

  static async fromRuntimeManifest(
    manifestUrl = new URL("../runtime-manifest.json", import.meta.url),
    contractDirectory?: URL,
  ): Promise<ApprovalCompanionLauncher> {
    const manifest = await readRuntimeManifest(manifestUrl);
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
        runtimePath: artifact.path,
      })),
      loadVerifiedEntryBytes: true,
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
    const verified = await this.#verifyArtifact();
    const child = this.#spawnCompanion(verified !== undefined);
    return this.#exchange(child, context, verified);
  }

  async #verifyArtifact(): Promise<{
    readonly envelopeBytes: Buffer;
    readonly contractDocuments: ContractJsonDocuments;
  } | undefined> {
    let verifiedEntryBytes: Buffer | undefined;
    const contractDocuments: Partial<Record<ContractFileName, string>> = {};
    for (const artifact of this.#artifacts) {
      if (!isAbsolute(artifact.path)) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact path must be absolute",
        );
      }
      const entry = await lstat(artifact.path);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size <= 0 ||
        entry.size > maxApprovalArtifactBytes
      ) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact must be a regular non-symlink file",
        );
      }
      const bytes = await readFile(artifact.path);
      if (
        bytes.byteLength !== entry.size ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
          artifact.expectedSha256
      ) {
        throw new ApprovalError(
          "APPROVAL_ARTIFACT_INVALID",
          "Runtime artifact digest does not match the runtime manifest",
        );
      }
      if (artifact.path === this.#entryPath) {
        verifiedEntryBytes = bytes;
      }
      const contractFileName = contractFileNames.find(
        (fileName) => artifact.runtimePath === `contracts/schema/${fileName}`,
      );
      if (contractFileName !== undefined) {
        try {
          contractDocuments[contractFileName] = new TextDecoder("utf-8", {
            fatal: true,
          }).decode(bytes);
        } catch {
          throw new ApprovalError(
            "APPROVAL_ARTIFACT_INVALID",
            "Approval contract artifact is not valid UTF-8",
          );
        }
      }
    }
    if (verifiedEntryBytes === undefined) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval companion entry was not verified",
      );
    }
    if (!this.#loadVerifiedEntryBytes) return undefined;
    if (
      Object.keys(contractDocuments).sort().join("\n") !==
        [...contractFileNames].sort().join("\n")
    ) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Approval runtime does not contain the complete contract set",
      );
    }
    const completeDocuments = contractDocuments as ContractJsonDocuments;
    const envelopeBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: "huaweicloud-mate-verified-companion/v1",
        entrySource: verifiedEntryBytes.toString("base64"),
        contractDocuments: completeDocuments,
      }),
      "utf8",
    );
    if (
      envelopeBytes.byteLength <= 0 ||
      envelopeBytes.byteLength > maxApprovalArtifactBytes
    ) {
      throw new ApprovalError(
        "APPROVAL_ARTIFACT_INVALID",
        "Verified companion envelope exceeds the private source limit",
      );
    }
    return { envelopeBytes, contractDocuments: completeDocuments };
  }

  #spawnCompanion(loadVerifiedEntryBytes: boolean): ChildProcess {
    if (loadVerifiedEntryBytes) {
      return spawn(
        process.execPath,
        [
          "--disable-sigusr1",
          "--input-type=module",
          "--eval",
          companionBootstrapSource,
          pathToFileURL(this.#entryPath).href,
        ],
        {
          cwd: dirname(this.#entryPath),
          detached: false,
          env: minimalCompanionEnvironment(),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "ignore", "pipe", "ipc"],
        },
      );
    }
    return fork(this.#entryPath, [], {
      cwd: dirname(this.#entryPath),
      detached: false,
      env: minimalCompanionEnvironment(),
      execArgv: ["--disable-sigusr1"],
      execPath: process.execPath,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  }

  #exchange(
    child: ChildProcess,
    context: ApprovalSigningContext,
    verified?: {
      readonly envelopeBytes: Buffer;
      readonly contractDocuments: ContractJsonDocuments;
    },
  ): Promise<ApprovalReceipt | null> {
    return new Promise<ApprovalReceipt | null>((resolveResult, rejectResult) => {
      let settled = false;
      let readyBinding: ApprovalSessionBinding | undefined;
      let verifier: Promise<TrustedApprovalVerifier> | undefined;
      let bootstrapReady = verified === undefined;
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
        if (!bootstrapReady) {
          const failedStage = bootstrapErrorStage(rawMessage);
          if (failedStage !== undefined) {
            throw new ApprovalError(
              "APPROVAL_PROCESS_FAILED",
              `Approval companion bootstrap failed at ${failedStage}`,
            );
          }
          if (!isBootstrapReadyMessage(rawMessage)) {
            throw new ApprovalError(
              "APPROVAL_PROTOCOL_INVALID",
              "Approval companion bootstrap returned an invalid message",
            );
          }
          bootstrapReady = true;
          sendReview();
          return;
        }
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
              verified?.contractDocuments,
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
        void new Promise<void>((resolve) => setImmediate(resolve))
          .then(() => messageChain)
          .then(() => {
            if (!settled) {
              fail(
                new ApprovalError(
                  "APPROVAL_PROCESS_FAILED",
                  `Approval companion exited before a result (code=${String(code)}, signal=${String(signal)})`,
                ),
              );
            }
          })
          .catch(fail);
      });

      const sendReview = (): void => {
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
      };

      if (verified === undefined) {
        sendReview();
      } else if (child.stdin === null) {
        fail(
          new ApprovalError(
            "APPROVAL_PROCESS_FAILED",
            "Router could not open the private companion source channel",
          ),
        );
      } else {
        child.stdin.once("error", () => {
          fail(
            new ApprovalError(
              "APPROVAL_PROCESS_FAILED",
              "Router could not send the verified companion source",
            ),
          );
        });
        child.stdin.end(verified.envelopeBytes);
      }
    });
  }
}
