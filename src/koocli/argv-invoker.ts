import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { CredentialStore } from "../auth/credentials.js";
import {
  KooCliInvocationError,
  type KooCliInvocationRequest,
  type KooCliInvocationResult,
  type KooCliSecureInvoker,
} from "./adapter.js";

const argumentNamePattern = /^[A-Za-z_][A-Za-z0-9_.[\]{}-]{0,255}$/u;
const boundedValuePattern = /^[^\u0000]{0,16384}$/u;
const boundedIdentityPattern = /^[^\u0000\r\n]{1,512}$/u;
const maxInvocationArgvBytes = 24 * 1024;
const maxOutputBytes = 1024 * 1024;
const defaultTimeoutMs = 60_000;
const reservedArgumentNames = new Set([
  "debug",
  "dryrun",
  "help",
  "interactive",
  "skeleton",
]);

interface ReviewedInvocationPolicy {
  readonly outputQuery: string;
}

const reviewedInvocationPolicies = new Map<string, ReviewedInvocationPolicy>([
  [
    "ECS\u0000ListServersDetails",
    {
      outputQuery:
        "{count:length(servers),servers:servers[].{id:id,name:name,status:status},nextMarker:servers[-1].id}",
    },
  ],
]);

export interface KooCliArgvProcessRequest {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface KooCliArgvProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface KooCliArgvProcessRunner {
  run(request: KooCliArgvProcessRequest): Promise<KooCliArgvProcessResult>;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  for (const name of [
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "NO_PROXY",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  return environment;
}

export class NodeKooCliArgvProcessRunner implements KooCliArgvProcessRunner {
  async run(request: KooCliArgvProcessRequest): Promise<KooCliArgvProcessResult> {
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    if (
      !isAbsolute(request.executablePath) ||
      request.args.some((argument) =>
        typeof argument !== "string" || argument.includes("\u0000")) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 5 * 60_000
    ) {
      throw new KooCliInvocationError("validation-failed");
    }
    return await new Promise<KooCliArgvProcessResult>((resolveResult, rejectResult) => {
      const child = spawn(request.executablePath, [...request.args], {
        env: minimalEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let exceeded = false;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectResult(new KooCliInvocationError("unavailable"));
      };
      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          exceeded = true;
          child.kill();
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", fail);
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exceeded) {
          rejectResult(new KooCliInvocationError("validation-failed"));
          return;
        }
        resolveResult({ code, signal, stdout, stderr, timedOut });
      });
    });
  }
}

function renderArgument(name: string, value: unknown): string {
  if (
    !argumentNamePattern.test(name) ||
    name.toLowerCase().startsWith("cli-") ||
    reservedArgumentNames.has(name.toLowerCase())
  ) {
    throw new KooCliInvocationError("validation-failed");
  }
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else if (typeof value === "number" && Number.isFinite(value)) rendered = String(value);
  else if (typeof value === "boolean") rendered = String(value);
  else if (value === null || typeof value === "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new KooCliInvocationError("validation-failed");
    rendered = json;
  } else {
    throw new KooCliInvocationError("validation-failed");
  }
  if (!boundedValuePattern.test(rendered)) {
    throw new KooCliInvocationError("validation-failed");
  }
  return `--${name}=${rendered}`;
}

function boundedIdentity(value: string | undefined): void {
  if (value !== undefined && !boundedIdentityPattern.test(value)) {
    throw new KooCliInvocationError("validation-failed");
  }
}

function invocationArgs(
  request: KooCliInvocationRequest,
  accessKey: string,
  secretKey: string,
): readonly string[] {
  boundedIdentity(request.region);
  boundedIdentity(request.project);
  boundedIdentity(request.expectedDomainId);
  const policy = reviewedInvocationPolicies.get(`${request.service}\u0000${request.operation}`);
  if (policy === undefined) throw new KooCliInvocationError("validation-failed");
  const args = [request.service, request.operation];
  for (const [name, value] of Object.entries(request.arguments).sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (request.project !== undefined && name.toLowerCase() === "project_id") {
      throw new KooCliInvocationError("validation-failed");
    }
    args.push(renderArgument(name, value));
  }
  args.push(
    "--cli-mode=AKSK",
    `--cli-access-key=${accessKey}`,
    `--cli-secret-key=${secretKey}`,
    "--cli-agree-privacy-statement=true",
    "--cli-warning=false",
    "--cli-offline=true",
    "--cli-retry-count=0",
    "--cli-output=json",
    "--cli-skip-secure-verify=false",
    `--cli-query=${policy.outputQuery}`,
  );
  if (request.region !== undefined) args.push(`--cli-region=${request.region}`);
  if (request.project !== undefined) args.push(`--project_id=${request.project}`);
  if (request.expectedDomainId !== undefined) {
    args.push(`--cli-domain-id=${request.expectedDomainId}`);
  }
  if (Buffer.byteLength(args.join("\u0000"), "utf8") > maxInvocationArgvBytes) {
    throw new KooCliInvocationError("validation-failed");
  }
  return args;
}

function classifyFailure(output: string): KooCliInvocationError {
  if (/\b(?:401|403)\b|forbidden|permission|unauthori[sz]ed/iu.test(output)) {
    return new KooCliInvocationError("permission-denied");
  }
  if (/\b409\b|conflict/iu.test(output)) return new KooCliInvocationError("conflict");
  if (/\b429\b|rate.?limit|throttl/iu.test(output)) {
    return new KooCliInvocationError("rate-limited");
  }
  if (/timeout|timed out|deadline/iu.test(output)) {
    return new KooCliInvocationError("timeout");
  }
  return new KooCliInvocationError("unavailable");
}

function requestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const name of ["request_id", "requestId", "X-Request-Id"]) {
    const candidate = record[name];
    if (typeof candidate === "string" && boundedIdentityPattern.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface AuthorizedArgvKooCliInvokerOptions {
  readonly credentials: CredentialStore;
  readonly runner?: KooCliArgvProcessRunner;
}

export class AuthorizedArgvKooCliInvoker implements KooCliSecureInvoker {
  readonly #credentials: CredentialStore;
  readonly #runner: KooCliArgvProcessRunner;

  constructor(options: AuthorizedArgvKooCliInvokerOptions) {
    this.#credentials = options.credentials;
    this.#runner = options.runner ?? new NodeKooCliArgvProcessRunner();
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.#credentials.read() !== undefined;
    } catch {
      return false;
    }
  }

  async invoke(request: KooCliInvocationRequest): Promise<KooCliInvocationResult> {
    let snapshot;
    try {
      snapshot = await this.#credentials.read();
    } catch {
      throw new KooCliInvocationError("unavailable");
    }
    if (snapshot === undefined) throw new KooCliInvocationError("unavailable");
    const credentials = snapshot.credentials;
    if (
      credentials.generation !== request.credentialGeneration ||
      credentials.accountIdentity.accountId !== request.expectedAccountId ||
      credentials.accountIdentity.domainId !== request.expectedDomainId
    ) {
      throw new KooCliInvocationError("account-mismatch");
    }
    const result = await this.#runner.run({
      executablePath: request.executablePath,
      args: invocationArgs(request, credentials.accessKey, credentials.secretKey),
      timeoutMs: defaultTimeoutMs,
    });
    if (result.timedOut) throw new KooCliInvocationError("timeout");
    if (result.code !== 0) throw classifyFailure(`${result.stdout}\n${result.stderr}`);
    if (
      result.stdout.includes(credentials.accessKey) ||
      result.stdout.includes(credentials.secretKey)
    ) {
      throw new KooCliInvocationError("validation-failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, "")) as unknown;
    } catch {
      throw new KooCliInvocationError("validation-failed");
    }
    const parsedRequestId = requestId(parsed);
    return {
      result: parsed,
      effectiveAccountId: request.expectedAccountId,
      ...(request.project === undefined ? {} : { effectiveProjectId: request.project }),
      ...(request.region === undefined ? {} : { effectiveRegion: request.region }),
      ...(parsedRequestId === undefined ? {} : { requestId: parsedRequestId }),
    };
  }
}
