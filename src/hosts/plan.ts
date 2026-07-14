import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { InstallerError } from "../installer/errors.js";
import { isSafePluginVersion } from "../installer/install-manifest.js";
import type { HostId, HostTemplate } from "./types.js";

type SupportedPlatform = "win32" | "darwin" | "linux";

export interface HostPathRoots {
  readonly userConfig: string;
  readonly userData: string;
  readonly pluginRoot: string;
  readonly runtimeRoot: string;
}

export interface HostRuntimeBinding {
  readonly runtimeRoot: string;
  readonly versionDirectory: string;
  readonly stableLauncherPath: string;
  readonly nodePath: string;
}

export interface HostInstallPlan {
  readonly id: HostId;
  readonly displayName: string;
  readonly detectCommands: readonly string[];
  readonly detectPaths: readonly string[];
  readonly mergeStrategy: HostTemplate["mcp"]["mergeStrategy"];
  readonly configPath: string;
  readonly entryKey: "huaweicloud-agent";
  readonly configFragment: Readonly<Record<string, unknown>>;
  readonly pluginSourcePath?: string;
  readonly pluginTargetPath?: string;
  readonly skillSourcePath: string;
  readonly skillTargetPath: string;
}

const templatePathPattern =
  /^(\{userConfig\}|\{userData\}|\{pluginRoot\}|\{runtimeRoot\})[/\\](.+)$/u;

function invalid(message: string): never {
  throw new InstallerError("HOST_TEMPLATE_INVALID", message);
}

function pathApi(platform: SupportedPlatform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function samePath(
  left: string,
  right: string,
  platform: SupportedPlatform,
): boolean {
  if (platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isContained(
  root: string,
  candidate: string,
  platform: SupportedPlatform,
): boolean {
  const api = pathApi(platform);
  const relativePath = api.relative(root, candidate);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !api.isAbsolute(relativePath)
  );
}

export function defaultHostPathRoots(
  id: HostId,
  runtimeRoot: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform,
  homeDirectory = homedir(),
): HostPathRoots {
  const api = pathApi(platform);
  const userConfig = (() => {
    switch (id) {
      case "codex":
        return api.resolve(homeDirectory, ".codex");
      case "claude":
        return api.resolve(homeDirectory, ".claude");
      case "opencode":
        return api.resolve(homeDirectory, ".config", "opencode");
      case "codearts":
        return api.resolve(homeDirectory, ".codeartsdoer");
    }
  })();
  const resolvedRuntimeRoot = api.resolve(runtimeRoot);
  return {
    userConfig,
    userData: userConfig,
    pluginRoot: api.resolve(
      resolvedRuntimeRoot,
      "hosts",
      id,
      "huaweicloud-mate",
    ),
    runtimeRoot: resolvedRuntimeRoot,
  };
}

export function resolveHostTemplatePath(
  templatePath: string,
  roots: HostPathRoots,
  platform: SupportedPlatform = process.platform as SupportedPlatform,
): string {
  const match = templatePathPattern.exec(templatePath);
  if (match === null) {
    return invalid("Host template path has an unsupported root token");
  }
  const token = match[1];
  const suffix = match[2];
  if (token === undefined || suffix === undefined) {
    return invalid("Host template path is incomplete");
  }
  const segments = suffix.split(/[/\\]/u);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return invalid("Host template path contains an unsafe segment");
  }
  const rootName = token.slice(1, -1) as keyof HostPathRoots;
  const root = roots[rootName];
  const api = pathApi(platform);
  const candidate = api.resolve(root, ...segments);
  if (!isContained(api.resolve(root), candidate, platform)) {
    return invalid("Host template path escapes its declared root");
  }
  return candidate;
}

function renderConfigFragment(
  template: HostTemplate,
  binding: HostRuntimeBinding,
): Readonly<Record<string, unknown>> {
  const launcherArguments = [
    binding.stableLauncherPath,
    ...template.mcp.launcher.args,
  ];
  if (template.mcp.mergeStrategy === "plugin-manifest") {
    return {
      mcpServers: {
        [template.mcp.entryKey]: {
          command: binding.nodePath,
          args: launcherArguments,
        },
      },
    };
  }
  return {
    mcp: {
      [template.mcp.entryKey]: {
        type: "local",
        command: [binding.nodePath, ...launcherArguments],
        enabled: true,
      },
    },
  };
}

export function createHostInstallPlan(
  template: HostTemplate,
  binding: HostRuntimeBinding,
  platform: SupportedPlatform = process.platform as SupportedPlatform,
  homeDirectory = homedir(),
): HostInstallPlan {
  const api = pathApi(platform);
  const runtimeRoot = api.resolve(binding.runtimeRoot);
  const versionDirectory = api.resolve(binding.versionDirectory);
  const stableLauncherPath = api.resolve(binding.stableLauncherPath);
  const nodePath = api.resolve(binding.nodePath);
  const versionsRoot = api.resolve(runtimeRoot, "versions");
  if (
    !api.isAbsolute(binding.runtimeRoot) ||
    !api.isAbsolute(binding.versionDirectory) ||
    !api.isAbsolute(binding.stableLauncherPath) ||
    !api.isAbsolute(binding.nodePath) ||
    !isContained(versionsRoot, versionDirectory, platform) ||
    !samePath(api.dirname(versionDirectory), versionsRoot, platform) ||
    !isSafePluginVersion(api.basename(versionDirectory)) ||
    !samePath(
      stableLauncherPath,
      api.resolve(runtimeRoot, "current", "hcloud-agent.mjs"),
      platform,
    )
  ) {
    return invalid("Host runtime binding does not use the stable runtime layout");
  }

  const normalizedBinding = {
    runtimeRoot,
    versionDirectory,
    stableLauncherPath,
    nodePath,
  };
  const roots = defaultHostPathRoots(
    template.id,
    normalizedBinding.runtimeRoot,
    platform,
    homeDirectory,
  );
  const isPlugin = template.mcp.mergeStrategy === "plugin-manifest";
  let pluginSourcePath: string | undefined;
  let skillSourcePath: string;
  if (isPlugin) {
    pluginSourcePath = api.resolve(
        normalizedBinding.versionDirectory,
        "host-assets",
        template.id,
        "plugin",
      );
    skillSourcePath = api.resolve(
      pluginSourcePath,
      "skills",
      "huaweicloud",
    );
  } else {
    skillSourcePath = api.resolve(
        normalizedBinding.versionDirectory,
        "skills",
        "canonical",
        "huaweicloud",
      );
  }

  return {
    id: template.id,
    displayName: template.displayName,
    detectCommands: [...template.detect.commands],
    detectPaths: template.detect.paths.map((path) =>
      resolveHostTemplatePath(path, roots, platform),
    ),
    mergeStrategy: template.mcp.mergeStrategy,
    configPath: resolveHostTemplatePath(
      template.mcp.configPath,
      roots,
      platform,
    ),
    entryKey: template.mcp.entryKey,
    configFragment: renderConfigFragment(template, normalizedBinding),
    ...(pluginSourcePath === undefined
      ? {}
      : {
          pluginSourcePath,
          pluginTargetPath: roots.pluginRoot,
        }),
    skillSourcePath,
    skillTargetPath: resolveHostTemplatePath(
      template.skills.targetPath,
      roots,
      platform,
    ),
  };
}
