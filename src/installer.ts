import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";

type AgentName = "codex" | "claude-code" | "opencode";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@hd_vector/huaweicloud-meta";
const DEFAULT_WINDOWS_KOOCLI_URL = "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-windows-amd64.zip";

function agentFrom(args: string[]): AgentName | undefined {
  const value = args[args.indexOf("--agent") + 1];
  return value === "codex" || value === "claude-code" || value === "opencode" ? value : undefined;
}

function koocliRoot(): string {
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), "huaweicloud-mate", "koocli");
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
  const root = koocliRoot();
  const executable = join(root, "hcloud.exe");
  if (existsSync(executable)) return executable;
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

function configurationCommand(agent: AgentName): string {
  if (agent === "codex") return `codex mcp add huaweicloud-mate -- npx -y ${PACKAGE_NAME}`;
  if (agent === "claude-code") return `claude mcp add --transport stdio --scope user huaweicloud-mate -- npx -y ${PACKAGE_NAME}`;
  return `Add to opencode.json: { "mcp": { "huaweicloud-mate": { "type": "local", "command": ["npx", "-y", "${PACKAGE_NAME}"] } } }`;
}

export async function runInstaller(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: huaweicloud-mate install --agent codex|claude-code|opencode\n");
    return;
  }
  const agent = agentFrom(args);
  if (!agent) throw new Error("Specify --agent codex, claude-code, or opencode.");
  const executable = await ensureWindowsKooCli();
  await execFileAsync(executable, ["version"]);
  process.stdout.write(`KooCLI is ready at ${executable}.\n`);
  process.stdout.write(`Configure ${agent}:\n${configurationCommand(agent)}\n`);
  process.stdout.write("Run `hcloud configure init` in a user-visible terminal to enter AK/SK and a default Region.\n");
}
