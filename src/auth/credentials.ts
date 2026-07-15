import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { AuthError } from "./errors.js";
import {
  type CredentialPermissionPolicy,
  defaultCredentialPermissionPolicy,
} from "./permissions.js";
import type { CredentialSnapshot, StoredCredentials } from "./types.js";

const maxCredentialBytes = 32 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface FileSnapshot {
  readonly exists: boolean;
  readonly bytes?: Buffer;
  readonly sha256?: string;
}

export interface CredentialStoreOptions {
  readonly path: string;
  readonly permissions?: CredentialPermissionPolicy;
}

function invalid(message: string): never {
  throw new AuthError("AUTH_CREDENTIALS_INVALID", message);
}

function conflict(message: string): never {
  throw new AuthError("AUTH_CREDENTIALS_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "EEXIST";
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000\r\n]/u.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function parseStoredCredentials(value: unknown): StoredCredentials {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "accessKey",
      "secretKey",
      "generation",
      "accountIdentity",
      "validatedAt",
      "updatedAt",
    ]) ||
    value.schemaVersion !== "huaweicloud-mate-credentials/v1" ||
    !isBoundedText(value.accessKey, 4096) ||
    !isBoundedText(value.secretKey, 4096) ||
    typeof value.generation !== "string" ||
    !uuidV4Pattern.test(value.generation) ||
    !isIsoDate(value.validatedAt) ||
    !isIsoDate(value.updatedAt) ||
    !isRecord(value.accountIdentity)
  ) {
    return invalid("Credential storage does not match the required schema");
  }
  const identity = value.accountIdentity;
  const identityKeys = identity.domainId === undefined
    ? ["accountId"]
    : ["accountId", "domainId"];
  if (
    !exactKeys(identity, identityKeys) ||
    !isBoundedText(identity.accountId, 256) ||
    (identity.domainId !== undefined && !isBoundedText(identity.domainId, 256)) ||
    Date.parse(value.validatedAt) > Date.parse(value.updatedAt)
  ) {
    return invalid("Credential account identity is invalid");
  }
  return {
    schemaVersion: "huaweicloud-mate-credentials/v1",
    accessKey: value.accessKey,
    secretKey: value.secretKey,
    generation: value.generation,
    accountIdentity: {
      accountId: identity.accountId,
      ...(identity.domainId === undefined ? {} : { domainId: identity.domainId }),
    },
    validatedAt: value.validatedAt,
    updatedAt: value.updatedAt,
  };
}

function decode(bytes: Uint8Array): StoredCredentials {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Credential storage is not valid UTF-8");
  }
  try {
    return parseStoredCredentials(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    return invalid("Credential storage is not valid JSON");
  }
}

export class CredentialStore {
  readonly path: string;
  private readonly permissions: CredentialPermissionPolicy;

  constructor(options: CredentialStoreOptions) {
    if (!isAbsolute(options.path)) {
      throw new AuthError(
        "AUTH_CREDENTIALS_INVALID",
        "Credential storage path must be absolute",
      );
    }
    this.path = resolve(options.path);
    this.permissions = options.permissions ?? defaultCredentialPermissionPolicy();
  }

  private async ensureParent(): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return invalid("Credential storage parent is not a regular directory");
    }
    await this.permissions.secureDirectory(parent);
  }

  private async snapshot(verifyPermissions: boolean): Promise<FileSnapshot> {
    let entry;
    try {
      entry = await lstat(this.path);
    } catch (error) {
      if (isMissing(error)) {
        return { exists: false };
      }
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxCredentialBytes) {
      return invalid("Credential storage must be a regular file within the size limit");
    }
    if (verifyPermissions) {
      await this.permissions.verifyFile(this.path);
    }
    const bytes = await readFile(this.path);
    if (bytes.byteLength !== entry.size || bytes.byteLength > maxCredentialBytes) {
      return conflict("Credential storage changed while it was being read");
    }
    return { exists: true, bytes, sha256: digest(bytes) };
  }

  async read(): Promise<CredentialSnapshot | undefined> {
    try {
      const snapshot = await this.snapshot(true);
      if (!snapshot.exists || snapshot.bytes === undefined || snapshot.sha256 === undefined) {
        return undefined;
      }
      return { credentials: decode(snapshot.bytes), sha256: snapshot.sha256 };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError("AUTH_CREDENTIALS_INVALID", "Credential storage could not be read");
    }
  }

  private async writeTemporary(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.permissions.secureFile(path);
  }

  async replace(
    credentials: StoredCredentials,
    expectedSha256: string | null,
  ): Promise<CredentialSnapshot> {
    if (expectedSha256 !== null && !digestPattern.test(expectedSha256)) {
      return invalid("Expected credential digest is invalid");
    }
    const normalized = parseStoredCredentials(credentials);
    const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    if (bytes.byteLength > maxCredentialBytes) {
      return invalid("Rendered credential storage exceeds the size limit");
    }
    await this.ensureParent();
    const before = await this.snapshot(true);
    if (
      expectedSha256 === null ? before.exists : !before.exists || before.sha256 !== expectedSha256
    ) {
      return conflict("Credential storage no longer matches the expected version");
    }
    const temporaryPath = resolve(
      dirname(this.path),
      `.${basename(this.path)}.${randomBytes(16).toString("hex")}.tmp`,
    );
    let committed = false;
    try {
      await this.writeTemporary(temporaryPath, bytes);
      const current = await this.snapshot(true);
      if (
        expectedSha256 === null
          ? current.exists
          : !current.exists || current.sha256 !== expectedSha256
      ) {
        return conflict("Credential storage changed during the transaction");
      }
      if (expectedSha256 === null) {
        try {
          await link(temporaryPath, this.path);
        } catch (error) {
          if (isAlreadyPresent(error)) {
            return conflict("Credential storage appeared during the transaction");
          }
          throw error;
        }
      } else {
        await rename(temporaryPath, this.path);
      }
      committed = true;
      await this.permissions.verifyFile(this.path);
      return { credentials: normalized, sha256: digest(bytes) };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError("AUTH_CREDENTIALS_WRITE_FAILED", "Credential storage could not be updated");
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } catch (error) {
        if (!committed) {
          throw error;
        }
      }
    }
  }

  async remove(expectedSha256: string): Promise<void> {
    if (!digestPattern.test(expectedSha256)) {
      return invalid("Expected credential digest is invalid");
    }
    const before = await this.snapshot(true);
    if (!before.exists || before.sha256 !== expectedSha256) {
      return conflict("Credential storage no longer matches the expected version");
    }
    const quarantinePath = resolve(
      dirname(this.path),
      `.${basename(this.path)}.${randomBytes(16).toString("hex")}.remove`,
    );
    try {
      await rename(this.path, quarantinePath);
      const moved = await readFile(quarantinePath);
      if (digest(moved) !== expectedSha256) {
        try {
          await link(quarantinePath, this.path);
        } catch {
          // A concurrent writer owns the new path; never overwrite it.
        }
        return conflict("Credential storage changed during removal");
      }
      await unlink(quarantinePath);
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError("AUTH_CREDENTIALS_WRITE_FAILED", "Credential storage could not be removed");
    }
  }
}
