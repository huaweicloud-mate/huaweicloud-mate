import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredCredentials {
  accessKey: string;
  secretKey: string;
  region?: string;
  projectId?: string;
}

let attemptedRead = false;
let cachedCredentials: StoredCredentials | undefined;

function credentialFilePath(): string {
  if (process.env.HUAWEICLOUD_CREDENTIAL_FILE) return process.env.HUAWEICLOUD_CREDENTIAL_FILE;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), "huaweicloud-mate", "openapi-credentials.dpapi");
  if (process.platform === "linux") return linuxCredentialFilePath();
  throw new Error("Persistent OpenAPI credentials are supported on Windows and Linux only in this release.");
}

export function linuxCredentialFilePath(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(environment.XDG_CONFIG_HOME ?? join(home, ".config"), "huaweicloud-mate", "openapi-credentials.json");
}

function quotedPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateStoredCredentials(value: unknown): StoredCredentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Stored Huawei Cloud credentials have an invalid format.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessKey !== "string" || !candidate.accessKey || typeof candidate.secretKey !== "string" || !candidate.secretKey) throw new Error("Stored Huawei Cloud credentials are incomplete. Run `huaweicloud-mate configure` again.");
  if (candidate.region !== undefined && typeof candidate.region !== "string") throw new Error("Stored Huawei Cloud credentials have an invalid region.");
  if (candidate.projectId !== undefined && typeof candidate.projectId !== "string") throw new Error("Stored Huawei Cloud credentials have an invalid project ID.");
  return { accessKey: candidate.accessKey, secretKey: candidate.secretKey, region: candidate.region as string | undefined, projectId: candidate.projectId as string | undefined };
}

export function loadStoredCredentials(): StoredCredentials | undefined {
  if (attemptedRead) return cachedCredentials;
  attemptedRead = true;
  const credentialFile = credentialFilePath();
  if (process.platform === "win32") {
    if (!existsSync(credentialFile)) return undefined;
    const script = `$ErrorActionPreference = 'Stop'; $cipher = [System.IO.File]::ReadAllText(${quotedPowerShell(credentialFile)}); $secure = ConvertTo-SecureString -String $cipher; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }`;
    try {
      const plaintext = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      cachedCredentials = validateStoredCredentials(JSON.parse(plaintext));
      return cachedCredentials;
    } catch {
      throw new Error("Stored Huawei Cloud credentials cannot be decrypted for this Windows user. Run `huaweicloud-mate configure` to replace them, or `clear-credentials` to remove them.");
    }
  }
  if (process.platform === "linux") {
    const secret = readLinuxSecretService();
    const plaintext = secret ?? (existsSync(credentialFile) ? readLinuxCredentialFile(credentialFile) : undefined);
    if (!plaintext) return undefined;
    try {
      cachedCredentials = validateStoredCredentials(JSON.parse(plaintext));
      return cachedCredentials;
    } catch {
      throw new Error("Stored Huawei Cloud credentials cannot be read. Run `huaweicloud-mate configure` to replace them, or `clear-credentials` to remove them.");
    }
  }
  return undefined;
}

function readLinuxSecretService(): string | undefined {
  try {
    return execFileSync("secret-tool", ["lookup", "service", "huaweicloud-mate", "type", "openapi-credentials"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readLinuxCredentialFile(file: string): string {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error("Linux credential file permissions must be owner-only (600).");
  return readFileSync(file, "utf8");
}

function configureWindowsCredentials(credentialFile: string): void {
  const script = `$ErrorActionPreference = 'Stop'; $ak = Read-Host -Prompt 'Huawei Cloud AK'; $sk = Read-Host -Prompt 'Huawei Cloud SK' -AsSecureString; $region = Read-Host -Prompt 'Default Region'; $projectId = Read-Host -Prompt 'Default Project ID (optional)'; if ([string]::IsNullOrWhiteSpace($ak) -or $sk.Length -eq 0) { throw 'AK and SK are required.' }; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sk); try { $skPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); $payload = [ordered]@{ version = 1; accessKey = $ak; secretKey = $skPlain; region = $region; projectId = $projectId } | ConvertTo-Json -Compress; $payloadSecure = ConvertTo-SecureString -String $payload -AsPlainText -Force; $cipher = ConvertFrom-SecureString -SecureString $payloadSecure; [System.IO.Directory]::CreateDirectory(${quotedPowerShell(dirname(credentialFile))}) | Out-Null; [System.IO.File]::WriteAllText(${quotedPowerShell(credentialFile)}, $cipher, [System.Text.UTF8Encoding]::new($false)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "inherit", windowsHide: false });
  if (result.error) throw new Error(`Unable to configure encrypted credentials: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Encrypted credential configuration exited with code ${result.status ?? "unknown"}.`);
  process.stdout.write("Encrypted OpenAPI credentials were saved for the current Windows user. Re-run this command at any time to replace them.\n");
}

function configureLinuxCredentials(credentialFile: string): void {
  const script = String.raw`
set -eu
node_bin="$1"
credential_file="$2"
read -r -p 'Huawei Cloud AK: ' access_key
printf 'Huawei Cloud SK: ' >&2
IFS= read -r -s secret_key
printf '\n' >&2
read -r -p 'Default Region: ' region
read -r -p 'Default Project ID (optional): ' project_id
if [ -z "$access_key" ] || [ -z "$secret_key" ]; then
  echo 'AK and SK are required.' >&2
  exit 1
fi
emit_credentials() {
  printf '%s\0%s\0%s\0%s' "$access_key" "$secret_key" "$region" "$project_id" | "$node_bin" -e 'const values = require("node:fs").readFileSync(0, "utf8").split("\0"); process.stdout.write(JSON.stringify({ version: 1, accessKey: values[0], secretKey: values[1], region: values[2], projectId: values[3] }));'
}
if command -v secret-tool >/dev/null 2>&1; then
  if emit_credentials | secret-tool store --label='Huawei Cloud Agent credentials' service huaweicloud-mate type openapi-credentials; then
    echo 'OpenAPI credentials were saved in the Linux system keyring.'
    exit 0
  fi
  echo 'Linux system keyring is unavailable or locked.' >&2
fi
read -r -p "Store credentials in $credential_file with owner-only (600) permissions? [y/N] " allow_file
case "$allow_file" in
  y|Y|yes|YES)
    umask 077
    mkdir -p "$(dirname "$credential_file")"
    chmod 700 "$(dirname "$credential_file")"
    emit_credentials > "$credential_file"
    chmod 600 "$credential_file"
    echo "OpenAPI credentials were saved in $credential_file with owner-only permissions."
    ;;
  *)
    echo 'Credentials were not saved.' >&2
    exit 1
    ;;
esac
`;
  const result = spawnSync("bash", ["-c", script, "huaweicloud-mate", process.execPath, credentialFile], { stdio: "inherit", windowsHide: false });
  if (result.error) throw new Error(`Unable to configure Linux credentials: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Linux credential configuration exited with code ${result.status ?? "unknown"}.`);
}

function resetCredentialCache(): void {
  attemptedRead = false;
  cachedCredentials = undefined;
}

function credentialPayload(input: StoredCredentials): string {
  const credentials = validateStoredCredentials(input);
  return JSON.stringify({
    version: 1,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
    region: credentials.region ?? "",
    projectId: credentials.projectId ?? "",
  });
}

function saveWindowsCredentials(credentialFile: string, payload: string): void {
  const script = `$ErrorActionPreference = 'Stop'; $payload = [Console]::In.ReadToEnd(); $secure = ConvertTo-SecureString -String $payload -AsPlainText -Force; $cipher = ConvertFrom-SecureString -SecureString $secure; [System.IO.Directory]::CreateDirectory(${quotedPowerShell(dirname(credentialFile))}) | Out-Null; [System.IO.File]::WriteAllText(${quotedPowerShell(credentialFile)}, $cipher, [System.Text.UTF8Encoding]::new($false))`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: payload, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error("Unable to save encrypted credentials for the current Windows user.");
  }
}

function saveLinuxCredentials(credentialFile: string, payload: string, allowFileFallback: boolean): void {
  try {
    execFileSync("secret-tool", ["store", "--label=Huawei Cloud Agent credentials", "service", "huaweicloud-mate", "type", "openapi-credentials"], { input: payload, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
    return;
  } catch {
    if (!allowFileFallback) {
      throw new Error("Linux system keyring is unavailable or locked. Re-open the local setup page and explicitly allow the owner-only credential-file fallback.");
    }
  }
  const directory = dirname(credentialFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(credentialFile, payload, { encoding: "utf8", mode: 0o600 });
  chmodSync(credentialFile, 0o600);
}

/**
 * Saves credentials supplied through an installer-owned local UI. Secrets are
 * passed to the OS credential store on stdin only; they are never command-line
 * arguments, Agent configuration, or log output.
 */
export function saveStoredCredentials(input: StoredCredentials, allowLinuxFileFallback = false): void {
  const payload = credentialPayload(input);
  const credentialFile = credentialFilePath();
  if (process.platform === "win32") saveWindowsCredentials(credentialFile, payload);
  else if (process.platform === "linux") saveLinuxCredentials(credentialFile, payload, allowLinuxFileFallback);
  else throw new Error("Persistent OpenAPI credentials are supported on Windows and Linux only in this release.");
  resetCredentialCache();
}

export function configureStoredCredentials(): void {
  const credentialFile = credentialFilePath();
  if (process.platform === "win32") configureWindowsCredentials(credentialFile);
  else if (process.platform === "linux") configureLinuxCredentials(credentialFile);
  else throw new Error("Persistent OpenAPI credentials are supported on Windows and Linux only in this release.");
  resetCredentialCache();
}

export function clearStoredCredentials(): void {
  const credentialFile = credentialFilePath();
  if (existsSync(credentialFile)) rmSync(credentialFile, { force: true });
  if (process.platform === "linux") spawnSync("secret-tool", ["clear", "service", "huaweicloud-mate", "type", "openapi-credentials"], { stdio: "ignore", windowsHide: true });
  resetCredentialCache();
  process.stdout.write("Encrypted OpenAPI credentials were removed for the current Windows user.\n");
}
