import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  approvalIssuerId,
  approvalSignatureAlgorithm,
  approvalVerifierKeyId,
} from "./constants.js";
import { ApprovalError } from "./errors.js";
import type { ApprovalPublicKeyBinding } from "./types.js";

export const approvalKeyFileNames = {
  privateKey: "approval-private-key.pem",
  publicBinding: "approval-public-key.json",
} as const;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parsePublicBinding(value: unknown): ApprovalPublicKeyBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval public key binding is not an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "createdAt",
    "issuerId",
    "publicKeySpki",
    "schemaVersion",
    "signatureAlgorithm",
    "verifierKeyId",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval public key binding has unexpected fields");
  }
  if (
    record.schemaVersion !== "huaweicloud-mate-approval-key/v1" ||
    record.issuerId !== approvalIssuerId ||
    record.verifierKeyId !== approvalVerifierKeyId ||
    record.signatureAlgorithm !== approvalSignatureAlgorithm ||
    typeof record.publicKeySpki !== "string" ||
    !/^[A-Za-z0-9_-]{32,2048}$/.test(record.publicKeySpki) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval public key binding is invalid");
  }
  return record as unknown as ApprovalPublicKeyBinding;
}

function publicSpki(privateKey: KeyObject): string {
  return createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64url");
}

async function assertPrivateFilePermissions(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const file = await stat(path);
  if ((file.mode & 0o077) !== 0) {
    throw new ApprovalError(
      "APPROVAL_KEY_INVALID",
      "Approval private key must not be accessible by group or other users",
    );
  }
}

export class ApprovalKeyStore {
  readonly binding: ApprovalPublicKeyBinding;
  readonly #privateKey: KeyObject;

  private constructor(
    binding: ApprovalPublicKeyBinding,
    privateKey: KeyObject,
  ) {
    this.binding = binding;
    this.#privateKey = privateKey;
  }

  static async initialize(
    directory: string,
    now = new Date(),
  ): Promise<ApprovalKeyStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
    }

    const privatePath = join(directory, approvalKeyFileNames.privateKey);
    const bindingPath = join(directory, approvalKeyFileNames.publicBinding);
    const lockPath = join(directory, ".approval-key-initialize.lock");

    const privateExists = await exists(privatePath);
    const bindingExists = await exists(bindingPath);
    if (privateExists !== bindingExists) {
      throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval key store is incomplete");
    }
    if (!privateExists) {
      try {
        await mkdir(lockPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new ApprovalError("APPROVAL_KEY_INVALID", "Approval key initialization is already in progress");
        }
        throw error;
      }

      try {
        const generated = generateKeyPairSync("ed25519");
        const privatePem = generated.privateKey.export({
          format: "pem",
          type: "pkcs8",
        });
        const binding: ApprovalPublicKeyBinding = {
          schemaVersion: "huaweicloud-mate-approval-key/v1",
          issuerId: approvalIssuerId,
          verifierKeyId: approvalVerifierKeyId,
          signatureAlgorithm: approvalSignatureAlgorithm,
          publicKeySpki: generated.publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64url"),
          createdAt: now.toISOString(),
        };

        await writeFile(privatePath, privatePem, { flag: "wx", mode: 0o600 });
        try {
          await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          await rm(privatePath, { force: true });
          throw error;
        }
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    }

    await assertPrivateFilePermissions(privatePath);
    const binding = parsePublicBinding(
      JSON.parse(await readFile(bindingPath, "utf8")) as unknown,
    );
    const privateKey = createPrivateKey(await readFile(privatePath, "utf8"));
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      publicSpki(privateKey) !== binding.publicKeySpki
    ) {
      throw new ApprovalError(
        "APPROVAL_KEY_INVALID",
        "Approval private key does not match its public binding",
      );
    }

    return new ApprovalKeyStore(binding, privateKey);
  }

  sign(payload: Uint8Array): string {
    return sign(null, payload, this.#privateKey).toString("base64url");
  }
}

export function importApprovalPublicKey(
  binding: ApprovalPublicKeyBinding,
): KeyObject {
  const parsed = parsePublicBinding(binding);
  return createPublicKey({
    key: Buffer.from(parsed.publicKeySpki, "base64url"),
    format: "der",
    type: "spki",
  });
}
