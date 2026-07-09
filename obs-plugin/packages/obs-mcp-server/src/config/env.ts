import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

export interface ObsEnv {
  accessKeyId?: string;
  secretAccessKey?: string;
  securityToken?: string;
  region: string;
  endpoint?: string;
  enableWrite: boolean;
  enableDelete: boolean;
  enableConfigWrite: boolean;
  previewBytes: number;
}

const OBS_ENV_NAMES = [
  "HUAWEICLOUD_ACCESS_KEY_ID",
  "HUAWEICLOUD_SECRET_ACCESS_KEY",
  "HUAWEICLOUD_SECURITY_TOKEN",
  "HUAWEICLOUD_OBS_REGION",
  "HUAWEICLOUD_OBS_ENDPOINT",
  "HUAWEICLOUD_OBS_SERVER",
  "HUAWEICLOUD_OBS_ENABLE_WRITE",
  "HUAWEICLOUD_OBS_ENABLE_DELETE",
  "HUAWEICLOUD_OBS_ENABLE_CONFIG_WRITE",
  "HUAWEICLOUD_OBS_PREVIEW_BYTES"
] as const;

let supplementalEnvCache: NodeJS.ProcessEnv | undefined;

export function loadObsEnv(env: NodeJS.ProcessEnv = process.env): ObsEnv {
  const supplementalEnv = env === process.env ? loadSupplementalEnv() : {};
  const read = (name: string): string | undefined => env[name] || supplementalEnv[name];

  return {
    accessKeyId: read("HUAWEICLOUD_ACCESS_KEY_ID"),
    secretAccessKey: read("HUAWEICLOUD_SECRET_ACCESS_KEY"),
    securityToken: read("HUAWEICLOUD_SECURITY_TOKEN"),
    region: read("HUAWEICLOUD_OBS_REGION") ?? "cn-north-4",
    endpoint: read("HUAWEICLOUD_OBS_ENDPOINT") ?? read("HUAWEICLOUD_OBS_SERVER"),
    enableWrite: read("HUAWEICLOUD_OBS_ENABLE_WRITE") === "true",
    enableDelete: read("HUAWEICLOUD_OBS_ENABLE_DELETE") === "true",
    enableConfigWrite: read("HUAWEICLOUD_OBS_ENABLE_CONFIG_WRITE") === "true",
    previewBytes: Number.parseInt(read("HUAWEICLOUD_OBS_PREVIEW_BYTES") ?? "65536", 10)
  };
}

export function requireCredentials(env: ObsEnv): { accessKeyId: string; secretAccessKey: string } {
  if (!env.accessKeyId || !env.secretAccessKey) {
    throw new Error("Missing Huawei Cloud credentials. Set HUAWEICLOUD_ACCESS_KEY_ID and HUAWEICLOUD_SECRET_ACCESS_KEY.");
  }
  return {
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey
  };
}

function loadSupplementalEnv(): NodeJS.ProcessEnv {
  supplementalEnvCache ??= {
    ...loadWindowsRegistryEnv("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    ...loadWindowsRegistryEnv("HKCU\\Environment"),
    ...loadDotEnv()
  };
  return supplementalEnvCache;
}

function loadWindowsRegistryEnv(hive: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return {};
  }

  const values: NodeJS.ProcessEnv = {};
  for (const name of OBS_ENV_NAMES) {
    const value = readRegistryValue(hive, name);
    if (value !== undefined) {
      values[name] = value;
    }
  }
  return values;
}

function readRegistryValue(hive: string, name: string): string | undefined {
  try {
    const output = execFileSync("reg", ["query", hive, "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const line = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(name));
    return line?.replace(new RegExp(`^${name}\\s+REG_(?:EXPAND_)?SZ\\s+`), "");
  } catch {
    return undefined;
  }
}

function loadDotEnv(): NodeJS.ProcessEnv {
  const explicitPath = process.env.HUAWEICLOUD_OBS_ENV_FILE;
  const candidates = explicitPath ? [explicitPath] : discoverDotEnvCandidates();
  const env: NodeJS.ProcessEnv = {};

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    Object.assign(env, parseDotEnv(readFileSync(candidate, "utf8")));
  }
  return env;
}

function discoverDotEnvCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const workspaceEnv = join(moduleDir, "..", "..", "..", "..", ".env");
  const cwdEnv = findUp(process.cwd(), ".env");
  return [...new Set([cwdEnv, workspaceEnv].filter((path): path is string => Boolean(path)))];
}

function findUp(startDir: string, filename: string): string | undefined {
  let current = startDir;
  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current || current === parsePath(current).root) {
      return undefined;
    }
    current = parent;
  }
}

function parseDotEnv(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}
