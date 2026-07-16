import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isDeepStrictEqual, promisify } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { configureStoredCredentials, saveStoredCredentials, type StoredCredentials } from "./credentials";

type AgentName = "codex" | "claude-code" | "opencode";
type AgentSelection = AgentName | "auto";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@hd_vector/huaweicloud-meta";
const MCP_NAME = "huaweicloud-mate";
const CODEX_MCP_NAME = "huaweicloud_mate";
const DEFAULT_WINDOWS_KOOCLI_URL = "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-windows-amd64.zip";
const DEFAULT_LINUX_KOOCLI_BASE_URL = "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest";

function agentFrom(args: string[]): AgentSelection | undefined {
  const index = args.indexOf("--agent");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === "auto" || value === "codex" || value === "claude-code" || value === "opencode") return value;
  throw new Error("--agent must be auto, codex, claude-code, or opencode.");
}

interface AgentAdapter {
  id: AgentName;
  matches(environment: NodeJS.ProcessEnv): boolean;
}

const AGENT_ADAPTERS: readonly AgentAdapter[] = [
  {
    id: "codex",
    matches: (environment) => Boolean(environment.CODEX_THREAD_ID || environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.toLowerCase().includes("codex")),
  },
  {
    id: "claude-code",
    matches: (environment) => Boolean(environment.CLAUDE_PROJECT_DIR || environment.CLAUDECODE || environment.CLAUDE_CODE_ENTRYPOINT),
  },
  {
    id: "opencode",
    matches: (environment) => Boolean(environment.OPENCODE || environment.OPENCODE_CONFIG || environment.OPENCODE_CONFIG_DIR),
  },
];

export function detectCurrentAgent(environment: NodeJS.ProcessEnv = process.env): AgentName | undefined {
  return AGENT_ADAPTERS.find((adapter) => adapter.matches(environment))?.id;
}

export function resolveAgent(args: string[], environment: NodeJS.ProcessEnv = process.env): AgentName {
  const selected = agentFrom(args);
  if (selected && selected !== "auto") return selected;
  const detected = detectCurrentAgent(environment);
  if (detected) return detected;
  throw new Error("Could not detect the current Agent. The Agent should identify its own host and retry with its internal adapter id; the user does not need to choose one.");
}

export function shouldDeferInteractiveSetup(args: string[], inputIsTty = Boolean(stdin.isTTY), outputIsTty = Boolean(stdout.isTTY)): boolean {
  return (args.includes("--configure-koocli") || args.includes("--configure-openapi")) && (!inputIsTty || !outputIsTty);
}

/**
 * An installation is meant to be usable immediately. Unless explicitly
 * skipped, a bare install configures both credential consumers as well.
 * Explicit configuration flags preserve the caller's narrower selection.
 */
export function withDefaultCredentialSetup(args: string[]): string[] {
  if (args.includes("--skip-credentials") || args.includes("--configure-koocli") || args.includes("--configure-openapi")) return args;
  return [...args, "--configure-koocli", "--configure-openapi"];
}

type JsonObject = Record<string, unknown>;
type AgentConfigStatus = "created" | "updated" | "already-configured" | "kept";

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object.`);
  return value as JsonObject;
}

function mcpEntry(): JsonObject {
  return { type: "local", command: ["npx", "-y", PACKAGE_NAME] };
}

function claudeMcpEntry(): JsonObject {
  return { type: "stdio", command: "npx", args: ["-y", PACKAGE_NAME] };
}

function codexMcpTable(): string {
  return `[mcp_servers.${CODEX_MCP_NAME}]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_NAME}"]\nenabled = true\nstartup_timeout_sec = 15\n`;
}

export function mergeOpenCodeConfig(source: string): string {
  if (!source.trim()) return `${JSON.stringify({ mcp: { [MCP_NAME]: mcpEntry() } }, null, 2)}\n`;
  const errors: ParseError[] = [];
  const config = objectValue(parse(source, errors, { allowTrailingComma: true, disallowComments: false }), "OpenCode configuration");
  if (errors.length) throw new Error("OpenCode configuration contains invalid JSONC.");
  if (config.mcp !== undefined) objectValue(config.mcp, "OpenCode mcp");
  const updated = applyEdits(source, modify(source, ["mcp", MCP_NAME], mcpEntry(), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

export function mergeClaudeCodeConfig(source: string): string {
  const config = source.trim() ? objectValue(JSON.parse(source), "Claude Code configuration") : {};
  const mcpServers = config.mcpServers === undefined ? {} : objectValue(config.mcpServers, "Claude Code mcpServers");
  mcpServers[MCP_NAME] = claudeMcpEntry();
  config.mcpServers = mcpServers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function mergeCodexConfig(source: string): string {
  const table = codexMcpTable();
  const header = `[mcp_servers.${CODEX_MCP_NAME}]`;
  const start = source.search(new RegExp(`^${header.replace(/[.[\]{}()*+?^$\\|]/g, "\\$&")}\\s*$`, "m"));
  if (start < 0) return `${source.replace(/\s*$/, "")}\n\n${table}`;
  const nextTable = source.slice(start + header.length).search(/^\s*\[/m);
  const end = nextTable < 0 ? source.length : start + header.length + nextTable;
  return `${source.slice(0, start)}${table}${source.slice(end).replace(/^\s*\n?/, "")}`;
}

function jsonEntry(source: string, property: "mcp" | "mcpServers"): unknown {
  if (!source.trim()) return undefined;
  const config = objectValue(JSON.parse(source), "Agent configuration");
  if (config[property] === undefined) return undefined;
  return objectValue(config[property], property)[MCP_NAME];
}

function openCodeEntry(source: string): unknown {
  if (!source.trim()) return undefined;
  const errors: ParseError[] = [];
  const config = objectValue(parse(source, errors, { allowTrailingComma: true, disallowComments: false }), "OpenCode configuration");
  if (errors.length) throw new Error("OpenCode configuration contains invalid JSONC.");
  if (config.mcp === undefined) return undefined;
  return objectValue(config.mcp, "mcp")[MCP_NAME];
}

function codexTable(source: string): string | undefined {
  const header = `[mcp_servers.${CODEX_MCP_NAME}]`;
  const start = source.search(new RegExp(`^${header.replace(/[.[\]{}()*+?^$\\|]/g, "\\$&")}\\s*$`, "m"));
  if (start < 0) return undefined;
  const nextTable = source.slice(start + header.length).search(/^\s*\[/m);
  const end = nextTable < 0 ? source.length : start + header.length + nextTable;
  return source.slice(start, end).trim();
}

async function allowReplace(path: string, force: boolean): Promise<boolean> {
  if (force) return true;
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write(`[huaweicloud-mate] Existing ${MCP_NAME} configuration in ${path} was kept because this terminal is not interactive. Re-run with --force-agent-config to update it.\n`);
    return false;
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(`Existing ${MCP_NAME} configuration found in ${path}. Update it to ${PACKAGE_NAME}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function mergeJsonConfig(path: string, property: "mcp" | "mcpServers", expected: JsonObject, merge: (source: string) => string, force: boolean, readEntry = jsonEntry): Promise<AgentConfigStatus> {
  const existed = existsSync(path);
  const source = existed ? readFileSync(path, "utf8") : "";
  const current = readEntry(source, property);
  if (isDeepStrictEqual(current, expected)) return "already-configured";
  if (current !== undefined && !await allowReplace(path, force)) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merge(source), "utf8");
  return existed ? "updated" : "created";
}

export function resolveOpenCodeConfigPath(environment: NodeJS.ProcessEnv = process.env, home = homedir(), fileExists: (path: string) => boolean = existsSync): string {
  const directory = environment.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode");
  return environment.OPENCODE_CONFIG || [join(directory, "opencode.jsonc"), join(directory, "opencode.json")].find(fileExists) || join(directory, "opencode.json");
}

async function configureOpenCode(force: boolean): Promise<{ path: string; status: AgentConfigStatus }> {
  const path = resolveOpenCodeConfigPath();
  return { path, status: await mergeJsonConfig(path, "mcp", mcpEntry(), mergeOpenCodeConfig, force, (source) => openCodeEntry(source)) };
}

async function configureClaudeCode(force: boolean): Promise<{ path: string; status: AgentConfigStatus }> {
  const path = join(homedir(), ".claude.json");
  return { path, status: await mergeJsonConfig(path, "mcpServers", claudeMcpEntry(), mergeClaudeCodeConfig, force) };
}

async function configureCodex(force: boolean): Promise<{ path: string; status: AgentConfigStatus }> {
  const path = join(process.cwd(), ".codex", "config.toml");
  const existed = existsSync(path);
  const source = existed ? readFileSync(path, "utf8") : "";
  if (codexTable(source) === codexMcpTable().trim()) return { path, status: "already-configured" };
  if (codexTable(source) !== undefined && !await allowReplace(path, force)) return { path, status: "kept" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, mergeCodexConfig(source), "utf8");
  return { path, status: existed ? "updated" : "created" };
}

async function configureAgent(agent: AgentName, force: boolean): Promise<{ path: string; status: AgentConfigStatus }> {
  if (agent === "opencode") return configureOpenCode(force);
  if (agent === "claude-code") return configureClaudeCode(force);
  return configureCodex(force);
}

function koocliRoot(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), "huaweicloud-mate", "koocli");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "huaweicloud-mate", "koocli");
}

function koocliExecutableName(): string {
  return process.platform === "win32" ? "hcloud.exe" : "hcloud";
}

export function linuxKooCliUrl(architecture = process.arch, baseUrl = process.env.HUAWEICLOUD_KOOCLI_LINUX_BASE_URL ?? DEFAULT_LINUX_KOOCLI_BASE_URL): string {
  const asset = architecture === "x64" ? "amd64" : architecture === "arm64" ? "arm64" : undefined;
  if (!asset) throw new Error(`Automatic KooCLI installation does not support Linux architecture ${architecture}.`);
  return `${baseUrl}/huaweicloud-cli-linux-${asset}.tar.gz`;
}

async function existingKooCli(): Promise<string | undefined> {
  const localExecutable = join(koocliRoot(), koocliExecutableName());
  const candidates = [process.env.HUAWEICLOUD_KOOCLI_PATH, existsSync(localExecutable) ? localExecutable : undefined, koocliExecutableName(), "hcloud"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await execFileAsync(candidate, ["version"]);
      return candidate;
    } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

async function download(url: string, filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), filePath).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`KooCLI download failed with HTTP ${response.statusCode}`));
        return;
      }
      const target = createWriteStream(filePath);
      response.pipe(target);
      target.once("finish", () => target.close(() => resolve()));
      target.once("error", reject);
    });
    request.once("error", reject);
  });
}

async function ensureWindowsKooCli(): Promise<string> {
  if (process.platform !== "win32") throw new Error("Automatic KooCLI installation is supported on Windows only in this release.");
  const existing = await existingKooCli();
  if (existing) return existing;
  const root = koocliRoot();
  const executable = join(root, "hcloud.exe");
  mkdirSync(root, { recursive: true });
  const archive = join(root, "koocli.zip");
  const extracted = join(root, "extracted");
  await rm(extracted, { recursive: true, force: true });
  process.stderr.write("[huaweicloud-mate] Downloading KooCLI for Windows...\n");
  await download(process.env.HUAWEICLOUD_KOOCLI_WINDOWS_URL ?? DEFAULT_WINDOWS_KOOCLI_URL, archive);
  const escape = (value: string) => value.replace(/'/g, "''");
  const script = `Expand-Archive -LiteralPath '${escape(archive)}' -DestinationPath '${escape(extracted)}' -Force; $file = Get-ChildItem -LiteralPath '${escape(extracted)}' -Recurse -Filter hcloud.exe | Select-Object -First 1; if (-not $file) { throw 'hcloud.exe was not found in the downloaded archive' }; Move-Item -LiteralPath $file.FullName -Destination '${escape(executable)}' -Force`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
  await rm(archive, { force: true });
  await rm(extracted, { recursive: true, force: true });
  return executable;
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function ensureLinuxKooCli(): Promise<string> {
  if (process.platform !== "linux") throw new Error("Automatic Linux KooCLI installation can run on Linux only.");
  const existing = await existingKooCli();
  if (existing) return existing;
  const root = koocliRoot();
  const executable = join(root, "hcloud");
  const archive = join(root, "koocli.tar.gz");
  const extracted = join(root, "extracted");
  mkdirSync(root, { recursive: true });
  await rm(extracted, { recursive: true, force: true });
  await rm(archive, { force: true });
  mkdirSync(extracted, { recursive: true });
  process.stderr.write(`[huaweicloud-mate] Downloading KooCLI for Linux ${process.arch}...\n`);
  await download(linuxKooCliUrl(), archive);
  await execFileAsync("tar", ["-xzf", archive, "-C", extracted]);
  const extractedExecutable = findFile(extracted, "hcloud");
  if (!extractedExecutable) throw new Error("hcloud was not found in the downloaded Linux KooCLI archive.");
  await rm(executable, { force: true });
  await rename(extractedExecutable, executable);
  await chmod(executable, 0o700);
  await rm(archive, { force: true });
  await rm(extracted, { recursive: true, force: true });
  return executable;
}

async function ensureKooCli(): Promise<string> {
  if (process.platform === "win32") return ensureWindowsKooCli();
  if (process.platform === "linux") return ensureLinuxKooCli();
  throw new Error("Automatic KooCLI installation is supported on Windows and Linux only in this release.");
}

async function configureKooCli(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["configure", "init"], { shell: false, stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`KooCLI configuration exited with code ${code ?? "unknown"}.`)));
  });
}

interface LocalSetupOptions {
  executable: string;
  configureKooCli: boolean;
  configureOpenApi: boolean;
}

function setupValue(value: string | null): string {
  return value?.trim() ?? "";
}

function assertSingleLine(value: string, label: string): void {
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${label} is required and cannot contain a line break.`);
}

export function kooCliConfigureInput(credentials: StoredCredentials): string {
  assertSingleLine(credentials.accessKey, "AK");
  assertSingleLine(credentials.secretKey, "SK");
  assertSingleLine(credentials.region ?? "", "Default Region");
  return `y\n${credentials.accessKey}\n${credentials.secretKey}\n${credentials.region}\n`;
}

async function runKooCliWithInput(executable: string, args: string[], input: string, action: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < 16 * 1024) output += chunk.toString("utf8"); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && !/\[(?:USE|CLI|SDK)_ERROR\]/.test(output)) resolve();
      else reject(new Error(`KooCLI ${action} did not complete successfully.`));
    });
    child.stdin.end(input);
  });
}

async function configureKooCliFromSetup(executable: string, credentials: StoredCredentials): Promise<void> {
  // A fresh KooCLI asks for privacy-policy consent before it accepts any
  // configure command. Handle that prompt in a separate process so the
  // configure input always begins with its own destructive-reset confirmation.
  await runKooCliWithInput(executable, ["version"], "y\n", "privacy-policy consent");
  await runKooCliWithInput(executable, ["configure", "init"], kooCliConfigureInput(credentials), "credential initialization");
}

function setupPage(options: LocalSetupOptions, token: string, message?: string, success = false): string {
  const requested = [options.configureKooCli ? "KooCLI" : "", options.configureOpenApi ? "ECS/OBS OpenAPI" : ""].filter(Boolean).join(" 和 ");
  const detail = success
    ? `${requested} 已配置完成。此窗口可以关闭；请回到 Agent 并新开会话以加载 MCP 配置。`
    : `这一步会在本机完成 ${requested} 配置。AK/SK 只会通过本机回环地址传给安装器，不会发送到 Agent 聊天、配置文件或命令行。`;
  const fallback = options.configureOpenApi && process.platform === "linux"
    ? `<label class="check"><input type="checkbox" name="allowFileFallback" value="yes"> 若系统密钥环不可用，允许保存到仅当前用户可读的 600 凭据文件</label>`
    : "";
  const privacy = options.configureKooCli
    ? `<label class="check"><input type="checkbox" name="agreeKooCliPrivacy" value="yes" required> 我同意 KooCLI 的隐私政策，并允许安装器初始化其本地配置</label>`
    : "";
  const content = message ? `<p class="error">${message}</p>` : "";
  if (success) return `<!doctype html><meta charset="utf-8"><title>华为云插件配置完成</title><style>body{font:16px system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#172033}p{line-height:1.6}.ok{color:#176b3a}</style><h1>配置完成</h1><p class="ok">${detail}</p>`;
  return `<!doctype html><meta charset="utf-8"><title>华为云插件安全配置</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui;max-width:640px;margin:36px auto;padding:0 20px;color:#172033}p,label{line-height:1.5}form{display:grid;gap:14px;margin-top:24px}input{box-sizing:border-box;width:100%;padding:9px;font:inherit}.check input{width:auto;margin-right:8px}button{width:max-content;padding:10px 18px;font:inherit;background:#1769e0;color:#fff;border:0;border-radius:5px}.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:5px}</style><h1>完成华为云插件配置</h1><p>${detail}</p>${content}<form method="post" action="/configure"><input type="hidden" name="token" value="${token}"><label>Access Key ID (AK)<input name="accessKey" autocomplete="off" required></label><label>Secret Access Key (SK)<input name="secretKey" type="password" autocomplete="new-password" required></label><label>默认 Region<input name="region" value="cn-north-4" required></label>${privacy}${fallback}<button type="submit">安全保存并完成安装</button></form>`;
}

function responseHtml(response: import("node:http").ServerResponse, body: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function readSetupBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 16 * 1024) reject(new Error("The setup form is too large."));
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

/** Starts the one-time loopback setup page used when an Agent shell has no TTY. */
export async function runLocalSetupServer(args: string[]): Promise<string> {
  const executableIndex = args.indexOf("--koocli-path");
  const executable = executableIndex >= 0 ? args[executableIndex + 1] : undefined;
  const options: LocalSetupOptions = {
    executable: executable ?? "",
    configureKooCli: args.includes("--configure-koocli"),
    configureOpenApi: args.includes("--configure-openapi"),
  };
  if (!options.executable || (!options.configureKooCli && !options.configureOpenApi)) throw new Error("Local setup requires a KooCLI path and at least one configuration target.");
  const token = process.env.HUAWEICLOUD_SETUP_TOKEN;
  if (!token) throw new Error("Local setup token is missing.");
  let complete = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") return responseHtml(response, setupPage(options, token));
      if (request.method !== "POST" || request.url !== "/configure") return responseHtml(response, "Not found", 404);
      const form = new URLSearchParams(await readSetupBody(request));
      if (form.get("token") !== token) return responseHtml(response, "Invalid setup request.", 403);
      const credentials: StoredCredentials = {
        accessKey: setupValue(form.get("accessKey")),
        secretKey: setupValue(form.get("secretKey")),
        region: setupValue(form.get("region")),
      };
      assertSingleLine(credentials.accessKey, "AK");
      assertSingleLine(credentials.secretKey, "SK");
      assertSingleLine(credentials.region ?? "", "Default Region");
      if (options.configureKooCli && form.get("agreeKooCliPrivacy") !== "yes") throw new Error("Please agree to the KooCLI privacy policy before initialization.");
      if (options.configureKooCli) await configureKooCliFromSetup(options.executable, credentials);
      if (options.configureOpenApi) saveStoredCredentials(credentials, form.get("allowFileFallback") === "yes");
      complete = true;
      responseHtml(response, setupPage(options, token, undefined, true));
      setTimeout(() => server.close(), 100).unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Configuration failed.";
      responseHtml(response, setupPage(options, token, message));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local setup did not receive a loopback port.");
  const url = `http://127.0.0.1:${address.port}/`;
  if (typeof process.send === "function") process.send({ type: "huaweicloud-mate-setup", url });
  const timeout = setTimeout(() => {
    if (!complete) server.close();
  }, 20 * 60 * 1000);
  timeout.unref();
  return url;
}

async function launchLocalSetup(executable: string, args: string[]): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const setupArgs = [process.argv[1], "setup", "--koocli-path", executable, ...args.filter((arg) => arg === "--configure-koocli" || arg === "--configure-openapi")];
  const child = spawn(process.execPath, setupArgs, { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, HUAWEICLOUD_SETUP_TOKEN: token }, windowsHide: true });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The local setup page did not start within 10 seconds.")), 10_000);
    child.once("error", reject);
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { type?: string }).type === "huaweicloud-mate-setup" && typeof (message as { url?: string }).url === "string") {
        clearTimeout(timeout);
        resolve((message as { url: string }).url);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`The local setup page exited before it was ready (code ${code ?? "unknown"}).`));
    });
  });
  child.disconnect();
  child.unref();
  const opened = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn("xdg-open", [url], { detached: true, stdio: "ignore", windowsHide: true });
  opened.once("error", () => { /* The printed loopback URL remains usable. */ });
  opened.unref();
  return url;
}

export async function runInstaller(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: huaweicloud-mate install [--agent auto|codex|claude-code|opencode] [--skip-credentials] [--configure-koocli] [--configure-openapi] [--force-agent-config] [--skip-agent-config]\n");
    return;
  }
  const agent = resolveAgent(args);
  const setupArgs = withDefaultCredentialSetup(args);
  const configuresCredentials = setupArgs.includes("--configure-koocli") || setupArgs.includes("--configure-openapi");
  const executable = await ensureKooCli();
  process.stdout.write(`KooCLI is ready at ${executable}.\n`);
  const deferredInteractiveSetup = shouldDeferInteractiveSetup(setupArgs);
  if (deferredInteractiveSetup) {
    const url = await launchLocalSetup(executable, setupArgs);
    process.stdout.write(`This Agent shell has no interactive terminal, so a local secure setup page was started: ${url}\n`);
  } else {
    if (setupArgs.includes("--configure-koocli")) await configureKooCli(executable);
    if (setupArgs.includes("--configure-openapi")) configureStoredCredentials();
  }
  if (args.includes("--skip-agent-config")) {
    process.stdout.write(`Skipped ${agent} MCP configuration.\n`);
  } else {
    const configured = await configureAgent(agent, args.includes("--force-agent-config"));
    process.stdout.write(`${agent} MCP configuration ${configured.status}: ${configured.path}\n`);
  }
  if (deferredInteractiveSetup) process.stdout.write("Complete the local setup page to finish KooCLI and ECS/OBS credential configuration. Do not ask for AK/SK in chat or pass them as command-line arguments.\n");
  else if (configuresCredentials) process.stdout.write("KooCLI and ECS/OBS credentials were configured during this installation. Do not put AK/SK in project or Agent configuration files.\n");
  else {
    process.stdout.write("Credential setup was skipped. Re-run without --skip-credentials to complete KooCLI and ECS/OBS configuration.\n");
  }
}
