import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
  return process.env.HUAWEICLOUD_CREDENTIAL_FILE
    ?? join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), "huaweicloud-mate", "openapi-credentials.dpapi");
}

function quotedPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ensureWindows(): void {
  if (process.platform !== "win32") throw new Error("The encrypted local credential store is supported on Windows only in this release.");
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
  if (!existsSync(credentialFile)) return undefined;
  ensureWindows();
  const script = `$ErrorActionPreference = 'Stop'; $cipher = [System.IO.File]::ReadAllText(${quotedPowerShell(credentialFile)}); $secure = ConvertTo-SecureString -String $cipher; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }`;
  try {
    const plaintext = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    cachedCredentials = validateStoredCredentials(JSON.parse(plaintext));
    return cachedCredentials;
  } catch {
    throw new Error("Stored Huawei Cloud credentials cannot be decrypted for this Windows user. Run `huaweicloud-mate configure` to replace them, or `clear-credentials` to remove them.");
  }
}

export function configureStoredCredentials(): void {
  ensureWindows();
  const credentialFile = credentialFilePath();
  const script = `$ErrorActionPreference = 'Stop'; $ak = Read-Host -Prompt 'Huawei Cloud AK'; $sk = Read-Host -Prompt 'Huawei Cloud SK' -AsSecureString; $region = Read-Host -Prompt 'Default Region'; $projectId = Read-Host -Prompt 'Default Project ID (optional)'; if ([string]::IsNullOrWhiteSpace($ak) -or $sk.Length -eq 0) { throw 'AK and SK are required.' }; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sk); try { $skPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); $payload = [ordered]@{ version = 1; accessKey = $ak; secretKey = $skPlain; region = $region; projectId = $projectId } | ConvertTo-Json -Compress; $payloadSecure = ConvertTo-SecureString -String $payload -AsPlainText -Force; $cipher = ConvertFrom-SecureString -SecureString $payloadSecure; [System.IO.Directory]::CreateDirectory(${quotedPowerShell(dirname(credentialFile))}) | Out-Null; [System.IO.File]::WriteAllText(${quotedPowerShell(credentialFile)}, $cipher, [System.Text.UTF8Encoding]::new($false)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "inherit", windowsHide: false });
  if (result.error) throw new Error(`Unable to configure encrypted credentials: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Encrypted credential configuration exited with code ${result.status ?? "unknown"}.`);
  attemptedRead = false;
  cachedCredentials = undefined;
  process.stdout.write("Encrypted OpenAPI credentials were saved for the current Windows user. Re-run this command at any time to replace them.\n");
}

export function clearStoredCredentials(): void {
  const credentialFile = credentialFilePath();
  if (existsSync(credentialFile)) rmSync(credentialFile, { force: true });
  attemptedRead = false;
  cachedCredentials = undefined;
  process.stdout.write("Encrypted OpenAPI credentials were removed for the current Windows user.\n");
}
