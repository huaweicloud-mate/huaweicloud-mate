import { chmod, lstat } from "node:fs/promises";

import {
  type HostCommandRunner,
  NodeHostCommandRunner,
} from "../hosts/command-runner.js";
import { AuthError } from "./errors.js";

export interface CredentialPermissionPolicy {
  secureDirectory(path: string): Promise<void>;
  secureFile(path: string): Promise<void>;
  verifyFile(path: string): Promise<void>;
}

function permissionsError(message: string): never {
  throw new AuthError("AUTH_CREDENTIALS_PERMISSIONS", message);
}

export class PosixCredentialPermissionPolicy
  implements CredentialPermissionPolicy
{
  constructor(private readonly uid = process.getuid?.()) {}

  async secureDirectory(path: string): Promise<void> {
    await chmod(path, 0o700);
  }

  async secureFile(path: string): Promise<void> {
    await chmod(path, 0o600);
    await this.verifyFile(path);
  }

  async verifyFile(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return permissionsError("Credential storage is not a regular file");
    }
    if (this.uid !== undefined && entry.uid !== this.uid) {
      return permissionsError("Credential storage is not owned by the current user");
    }
    if ((entry.mode & 0o077) !== 0) {
      return permissionsError("Credential storage is accessible by another user");
    }
  }
}

export class WindowsCredentialPermissionPolicy
  implements CredentialPermissionPolicy
{
  private currentSid: string | undefined;

  constructor(
    private readonly runner: HostCommandRunner = new NodeHostCommandRunner(),
  ) {}

  async secureDirectory(_path: string): Promise<void> {
    // LocalAppData is the per-user boundary. The credential file itself is
    // independently reduced to a non-inherited current-user ACL below.
  }

  private async sid(): Promise<string> {
    if (this.currentSid !== undefined) {
      return this.currentSid;
    }
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

  private async enforceFileAcl(path: string): Promise<void> {
    const executable = await this.runner.resolveCommand("icacls");
    if (executable === undefined) {
      return permissionsError("Windows ACL command is unavailable");
    }
    const sid = await this.sid();
    const commands: readonly (readonly string[])[] = [
      [path, "/reset", "/c", "/q"],
      [path, "/inheritance:r", "/c", "/q"],
      [path, "/grant:r", `*${sid}:(F)`, "/c", "/q"],
      [path, "/findsid", `*${sid}`, "/c", "/q"],
    ];
    for (const args of commands) {
      const result = await this.runner.run(executable, args);
      if (result.code !== 0) {
        return permissionsError("Credential storage ACL could not be secured");
      }
    }
  }

  async secureFile(path: string): Promise<void> {
    await this.enforceFileAcl(path);
  }

  async verifyFile(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return permissionsError("Credential storage is not a regular file");
    }
    // Re-apply the canonical ACL instead of trusting localized icacls output.
    // This also repairs inherited or extra explicit entries before any secret is read.
    await this.enforceFileAcl(path);
  }
}

export function defaultCredentialPermissionPolicy(
  platform: NodeJS.Platform = process.platform,
  runner?: HostCommandRunner,
): CredentialPermissionPolicy {
  return platform === "win32"
    ? new WindowsCredentialPermissionPolicy(runner)
    : new PosixCredentialPermissionPolicy();
}
