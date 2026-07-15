import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface RuntimePathEnvironment {
  readonly LOCALAPPDATA?: string;
  readonly XDG_DATA_HOME?: string;
}

export function defaultRuntimeRoot(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
  environment: RuntimePathEnvironment = process.env,
): string {
  if (platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA === undefined ||
        environment.LOCALAPPDATA.length === 0
        ? win32.join(homeDirectory, "AppData", "Local")
        : environment.LOCALAPPDATA;
    return win32.resolve(localAppData, "hcloud-agent", "runtime");
  }
  if (platform === "darwin") {
    return posix.resolve(
      homeDirectory,
      "Library",
      "Application Support",
      "hcloud-agent",
      "runtime",
    );
  }
  const dataHome =
    environment.XDG_DATA_HOME === undefined ||
      environment.XDG_DATA_HOME.length === 0
      ? posix.join(homeDirectory, ".local", "share")
      : environment.XDG_DATA_HOME;
  return posix.resolve(dataHome, "hcloud-agent", "runtime");
}

export function defaultCredentialsPath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
  environment: RuntimePathEnvironment = process.env,
): string {
  return platform === "win32"
    ? win32.resolve(
        environment.LOCALAPPDATA === undefined ||
            environment.LOCALAPPDATA.length === 0
          ? win32.join(homeDirectory, "AppData", "Local")
          : environment.LOCALAPPDATA,
        "hcloud-agent",
        "credentials.json",
      )
    : platform === "darwin"
      ? posix.resolve(
          homeDirectory,
          "Library",
          "Application Support",
          "hcloud-agent",
          "credentials.json",
        )
      : posix.resolve(
          environment.XDG_DATA_HOME === undefined ||
              environment.XDG_DATA_HOME.length === 0
            ? posix.join(homeDirectory, ".local", "share")
            : environment.XDG_DATA_HOME,
          "hcloud-agent",
          "credentials.json",
        );
}

export function defaultAuditLogPath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
  environment: RuntimePathEnvironment = process.env,
): string {
  if (platform === "win32") {
    return win32.resolve(
      environment.LOCALAPPDATA === undefined ||
          environment.LOCALAPPDATA.length === 0
        ? win32.join(homeDirectory, "AppData", "Local")
        : environment.LOCALAPPDATA,
      "hcloud-agent",
      "logs",
      "router.jsonl",
    );
  }
  const dataRoot = platform === "darwin"
    ? posix.join(homeDirectory, "Library", "Application Support")
    : environment.XDG_DATA_HOME === undefined ||
        environment.XDG_DATA_HOME.length === 0
      ? posix.join(homeDirectory, ".local", "share")
      : environment.XDG_DATA_HOME;
  return posix.resolve(dataRoot, "hcloud-agent", "logs", "router.jsonl");
}
