import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { InstallerError } from "./errors.js";

export interface RuntimePermissionPolicy {
  secureRoot(path: string): Promise<void>;
  verifyRoot(path: string): Promise<void>;
}

const maxRuntimeEntries = 16_384;
const maxRuntimeDepth = 32;

function permissionsError(message: string): never {
  throw new InstallerError("RUNTIME_PERMISSIONS_FAILED", message);
}

async function verifyDirectory(path: string): Promise<Stats> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch {
    return permissionsError("Runtime root could not be inspected");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return permissionsError("Runtime root is not a regular directory");
  }
  return entry;
}

async function visitRuntimeTree(
  root: string,
  visitor: (path: string, entry: Stats) => Promise<void>,
): Promise<void> {
  let count = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > maxRuntimeDepth || count >= maxRuntimeEntries) {
      return permissionsError("Runtime tree exceeds the permissions verification limit");
    }
    count += 1;
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      return permissionsError("Runtime tree contains an unsupported filesystem entry");
    }
    await visitor(path, entry);
    if (!entry.isDirectory()) return;
    const children = await readdir(path);
    for (const child of children) {
      await visit(resolveChild(path, child), depth + 1);
    }
  };
  await visit(root, 0);
}

function resolveChild(parent: string, name: string): string {
  if (name === "" || name === "." || name === ".." || /[\\/]/u.test(name)) {
    return permissionsError("Runtime tree contains an invalid entry name");
  }
  return resolve(parent, name);
}

export class PosixRuntimePermissionPolicy implements RuntimePermissionPolicy {
  constructor(private readonly uid = process.getuid?.()) {}

  async secureRoot(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await verifyDirectory(path);
      await visitRuntimeTree(path, async (entryPath, entry) => {
        if (this.uid !== undefined && entry.uid !== this.uid) {
          return permissionsError("Runtime tree is not owned by the current user");
        }
        const mode = entry.isDirectory()
          ? 0o700
          : (entry.mode & 0o100) === 0
            ? 0o600
            : 0o700;
        await chmod(entryPath, mode);
      });
      await this.verifyRoot(path);
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      return permissionsError("Runtime root permissions could not be secured");
    }
  }

  async verifyRoot(path: string): Promise<void> {
    await verifyDirectory(path);
    await visitRuntimeTree(path, async (_entryPath, entry) => {
      if (this.uid !== undefined && entry.uid !== this.uid) {
        return permissionsError("Runtime tree is not owned by the current user");
      }
      if ((entry.mode & 0o077) !== 0) {
        return permissionsError("Runtime tree is accessible by another user");
      }
    });
  }
}

export class WindowsRuntimePermissionPolicy implements RuntimePermissionPolicy {
  private currentSid: string | undefined;

  constructor(
    private readonly runner: HostCommandRunner = new NodeHostCommandRunner(),
  ) {}

  private async sid(): Promise<string> {
    if (this.currentSid !== undefined) return this.currentSid;
    const executable = await this.runner.resolveCommand("whoami");
    if (executable === undefined) {
      return permissionsError("Windows account identity command is unavailable");
    }
    const result = await this.runner.run(executable, ["/user", "/fo", "csv", "/nh"]);
    const match = result.code === 0
      ? result.stdout.match(/S-1-(?:\d+-)+\d+/u)
      : null;
    if (match === null) {
      return permissionsError("Windows account SID could not be determined");
    }
    this.currentSid = match[0];
    return this.currentSid;
  }

  private async enforceRootAcl(path: string): Promise<void> {
    const executable = await this.runner.resolveCommand("icacls");
    if (executable === undefined) {
      return permissionsError("Windows ACL command is unavailable");
    }
    const sid = await this.sid();
    const commands: readonly (readonly string[])[] = [
      [path, "/reset", "/t", "/c", "/q", "/l"],
      [path, "/inheritance:r", "/t", "/c", "/q", "/l"],
      [path, "/grant:r", `*${sid}:(OI)(CI)(F)`, "/t", "/c", "/q", "/l"],
      [path, "/findsid", `*${sid}`, "/t", "/c", "/q", "/l"],
    ];
    for (const args of commands) {
      const result = await this.runner.run(executable, args);
      if (result.code !== 0) {
        return permissionsError("Runtime root ACL could not be secured");
      }
    }
  }

  async secureRoot(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
      await verifyDirectory(path);
      await visitRuntimeTree(path, async () => undefined);
      await this.enforceRootAcl(path);
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      return permissionsError("Runtime root permissions could not be secured");
    }
  }

  async verifyRoot(path: string): Promise<void> {
    await verifyDirectory(path);
    await visitRuntimeTree(path, async () => undefined);
    // Re-apply a canonical recursive ACL. This repairs inherited or explicit
    // entries on runtime versions, recovery evidence, backups, and private tools.
    await this.enforceRootAcl(path);
  }
}

export function defaultRuntimePermissionPolicy(
  platform: NodeJS.Platform = process.platform,
  runner?: HostCommandRunner,
): RuntimePermissionPolicy {
  return platform === "win32"
    ? new WindowsRuntimePermissionPolicy(runner)
    : new PosixRuntimePermissionPolicy();
}
