import { gunzipSync } from "node:zlib";
import { basename, posix } from "node:path";

import { unzipSync } from "fflate";

import { InstallerError } from "../installer/errors.js";

const maxExecutableBytes = 256 * 1024 * 1024;
const maxTarBytes = 320 * 1024 * 1024;
const maxEntries = 128;

function invalid(message: string): never {
  throw new InstallerError("KOOCLI_ARCHIVE_INVALID", message);
}

function safeArchivePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return invalid("KooCLI archive contains an unsafe path");
  }
  const normalized = posix.normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return invalid("KooCLI archive contains path traversal");
  }
  return normalized.replace(/^\.\//u, "");
}

function executableName(platform: "windows" | "posix"): string {
  return platform === "windows" ? "hcloud.exe" : "hcloud";
}

export function extractKooCliZip(
  archive: Uint8Array,
): Uint8Array {
  let candidateCount = 0;
  const files = unzipSync(archive, {
    filter: (file) => {
      const path = safeArchivePath(file.name);
      if (basename(path).toLowerCase() !== executableName("windows")) {
        return false;
      }
      candidateCount += 1;
      if (
        candidateCount > 1 ||
        file.originalSize <= 0 ||
        file.originalSize > maxExecutableBytes
      ) {
        return invalid("KooCLI ZIP executable entry is ambiguous or oversized");
      }
      return true;
    },
  });
  const values = Object.values(files);
  if (
    candidateCount !== 1 ||
    values.length !== 1 ||
    values[0] === undefined ||
    values[0].byteLength === 0 ||
    values[0].byteLength > maxExecutableBytes
  ) {
    return invalid("KooCLI ZIP does not contain exactly one bounded executable");
  }
  return values[0];
}

function asciiField(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  const field = bytes.subarray(0, end === -1 ? bytes.length : end);
  if (field.some((byte) => byte < 0x20 || byte > 0x7e)) {
    return invalid("KooCLI tar header contains non-ASCII metadata");
  }
  return Buffer.from(field).toString("ascii").trim();
}

function octalField(bytes: Uint8Array): number {
  const value = asciiField(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) {
    return invalid("KooCLI tar header contains an invalid octal field");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return invalid("KooCLI tar header contains an oversized field");
  }
  return parsed;
}

function verifyTarChecksum(header: Uint8Array): void {
  const expected = octalField(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) {
    return invalid("KooCLI tar header checksum is invalid");
  }
}

export function extractKooCliTarGz(archive: Uint8Array): Uint8Array {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxTarBytes });
  } catch {
    return invalid("KooCLI gzip stream is invalid or oversized");
  }
  let offset = 0;
  let entries = 0;
  let executable: Uint8Array | undefined;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    entries += 1;
    if (entries > maxEntries) {
      return invalid("KooCLI tar contains too many entries");
    }
    verifyTarChecksum(header);
    const name = asciiField(header.subarray(0, 100));
    const prefix = asciiField(header.subarray(345, 500));
    const path = safeArchivePath(prefix === "" ? name : `${prefix}/${name}`);
    const size = octalField(header.subarray(124, 136));
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength) {
      return invalid("KooCLI tar entry exceeds the archive boundary");
    }
    if (type !== "0" && type !== "5") {
      return invalid("KooCLI tar contains a link or unsupported entry type");
    }
    if (type === "0" && basename(path) === executableName("posix")) {
      if (
        executable !== undefined ||
        size <= 0 ||
        size > maxExecutableBytes
      ) {
        return invalid("KooCLI tar executable entry is ambiguous or oversized");
      }
      executable = Uint8Array.from(tar.subarray(contentStart, contentEnd));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (executable === undefined) {
    return invalid("KooCLI tar does not contain exactly one executable");
  }
  return executable;
}
