import { basename } from "node:path";

import { InstallerError } from "../installer/errors.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const trustedArtifactHost =
  "cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com";
export const pinnedPrivateKooCliVersion = "7.2.12";
const supportedPlatforms = new Set<KooCliPlatform>([
  "windows-amd64",
  "linux-amd64",
  "linux-arm64",
  "mac-amd64",
  "mac-arm64",
]);

export type KooCliPlatform =
  | "windows-amd64"
  | "linux-amd64"
  | "linux-arm64"
  | "mac-amd64"
  | "mac-arm64";

export interface KooCliArtifactBinding {
  readonly platform: KooCliPlatform;
  readonly version: typeof pinnedPrivateKooCliVersion;
  readonly archive: "zip" | "tar.gz";
  readonly url: string;
  readonly sha256: string;
}

function invalid(message: string): never {
  throw new InstallerError("KOOCLI_ARTIFACT_INVALID", message);
}

export function currentKooCliPlatform(
  platform = process.platform,
  arch = process.arch,
): KooCliPlatform {
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "mac-amd64";
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  return invalid(`KooCLI does not support ${platform}/${arch}`);
}

function expectedFileName(binding: KooCliArtifactBinding): string {
  const prefix = binding.platform === "windows-amd64"
    ? "huaweicloud-cli-windows-amd64"
    : `huaweicloud-cli-${binding.platform}`;
  return `${prefix}.${binding.archive === "zip" ? "zip" : "tar.gz"}`;
}

export function validateKooCliArtifactBinding(
  value: KooCliArtifactBinding,
): KooCliArtifactBinding {
  if (
    !supportedPlatforms.has(value.platform) ||
    value.version !== pinnedPrivateKooCliVersion ||
    !digestPattern.test(value.sha256) ||
    (value.archive !== "zip" && value.archive !== "tar.gz") ||
    (value.platform === "windows-amd64") !== (value.archive === "zip")
  ) {
    return invalid("KooCLI artifact binding has invalid version, digest, or format");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return invalid("KooCLI artifact URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== trustedArtifactHost ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== `/cli/latest/${expectedFileName(value)}` ||
    basename(url.pathname) !== expectedFileName(value)
  ) {
    return invalid(
      "KooCLI artifact URL must match the approved official HTTPS download object",
    );
  }
  return { ...value, url: url.href };
}

export function selectCurrentKooCliArtifact(
  values: readonly KooCliArtifactBinding[],
): KooCliArtifactBinding | undefined {
  const byPlatform = new Map<KooCliPlatform, KooCliArtifactBinding>();
  for (const value of values) {
    const binding = validateKooCliArtifactBinding(value);
    if (byPlatform.has(binding.platform)) {
      return invalid(`KooCLI has duplicate bindings for ${binding.platform}`);
    }
    byPlatform.set(binding.platform, binding);
  }
  return byPlatform.get(currentKooCliPlatform());
}
