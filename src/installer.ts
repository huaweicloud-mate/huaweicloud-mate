import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isDeepStrictEqual, promisify } from "node:util";
import { configureStoredCredentials } from "./credentials";

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
  const config = source.trim() ? objectValue(JSON.parse(source), "OpenCode configuration") : {};
  const mcp = config.mcp === undefined ? {} : objectValue(config.mcp, "OpenCode mcp");
  mcp[MCP_NAME] = mcpEntry();
  config.mcp = mcp;
  return `${JSON.stringify(config, null, 2)}\n`;
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

async function mergeJsonConfig(path: string, property: "mcp" | "mcpServers", expected: JsonObject, merge: (source: string) => string, force: boolean): Promise<AgentConfigStatus> {
  const existed = existsSync(path);
  const source = existed ? readFileSync(path, "utf8") : "";
  const current = jsonEntry(source, property);
  if (isDeepStrictEqual(current, expected)) return "already-configured";
  if (current !== undefined && !await allowReplace(path, force)) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merge(source), "utf8");
  return existed ? "updated" : "created";
}

async function configureOpenCode(force: boolean): Promise<{ path: string; status: AgentConfigStatus }> {
  const path = process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");
  return { path, status: await mergeJsonConfig(path, "mcp", mcpEntry(), mergeOpenCodeConfig, force) };
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

export async function runInstaller(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: huaweicloud-mate install [--agent auto|codex|claude-code|opencode] [--configure-koocli] [--configure-openapi] [--force-agent-config] [--skip-agent-config]\n");
    return;
  }
  const agent = resolveAgent(args);
  const executable = await ensureKooCli();
  await execFileAsync(executable, ["version"]);
  process.stdout.write(`KooCLI is ready at ${executable}.\n`);
  if (args.includes("--configure-koocli")) await configureKooCli(executable);
  if (args.includes("--configure-openapi")) configureStoredCredentials();
  if (args.includes("--skip-agent-config")) {
    process.stdout.write(`Skipped ${agent} MCP configuration.\n`);
  } else {
    const configured = await configureAgent(agent, args.includes("--force-agent-config"));
    process.stdout.write(`${agent} MCP configuration ${configured.status}: ${configured.path}\n`);
  }
  process.stdout.write("KooCLI fallback uses its local profile. To configure it now, add --configure-koocli; otherwise run `hcloud configure init` in a user-visible terminal.\n");
  process.stdout.write("The self-built ECS/OBS adapter reads encrypted local credentials configured by --configure-openapi. Explicit HUAWEICLOUD_AK, HUAWEICLOUD_SK, HUAWEICLOUD_REGION, and HUAWEICLOUD_PROJECT_ID environment variables take precedence for a temporary override. Do not put these values in project or Agent configuration files.\n");
}
