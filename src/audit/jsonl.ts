import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  type CredentialPermissionPolicy,
  defaultCredentialPermissionPolicy,
} from "../auth/permissions.js";
import { RouterError } from "../router/errors.js";
import type { RouterAuditEvent, RouterAuditSink } from "./types.js";

const maxRecordBytes = 16 * 1024;
const maxLogBytes = 8 * 1024 * 1024;

export interface JsonlAuditSinkOptions {
  readonly path: string;
  readonly permissions?: CredentialPermissionPolicy;
}

function unavailable(): never {
  throw new RouterError("UNKNOWN", "Local audit log is unavailable");
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

async function regularFile(path: string): Promise<Stats | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return unavailable();
    return entry;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export class JsonlAuditSink implements RouterAuditSink {
  readonly path: string;
  readonly #permissions: CredentialPermissionPolicy;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: JsonlAuditSinkOptions) {
    if (!isAbsolute(options.path)) unavailable();
    this.path = resolve(options.path);
    this.#permissions = options.permissions ?? defaultCredentialPermissionPolicy();
  }

  async #append(event: RouterAuditEvent): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (bytes.byteLength > maxRecordBytes) return unavailable();
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentEntry = await lstat(parent);
    if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) return unavailable();
    await this.#permissions.secureDirectory(parent);

    let current = await regularFile(this.path);
    if (current !== undefined) {
      await this.#permissions.verifyFile(this.path);
    }
    if (current !== undefined && current.size + bytes.byteLength > maxLogBytes) {
      const backup = `${this.path}.1`;
      const previousBackup = await regularFile(backup);
      if (previousBackup !== undefined) {
        await this.#permissions.verifyFile(backup);
        await rm(backup);
      }
      await rename(this.path, backup);
      await this.#permissions.secureFile(backup);
      current = undefined;
    }

    const handle = await open(this.path, current === undefined ? "ax" : "a", 0o600);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.isSymbolicLink() ||
        (current !== undefined &&
          (opened.dev !== current.dev || opened.ino !== current.ino))
      ) return unavailable();
      if (current === undefined) {
        await this.#permissions.secureFile(this.path);
      }
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  record(event: RouterAuditEvent): Promise<void> {
    const operation = this.#tail.then(() => this.#append(event));
    this.#tail = operation.catch(() => undefined);
    return operation.catch(() => unavailable());
  }
}
