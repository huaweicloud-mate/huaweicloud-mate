import { gzipSync } from "node:zlib";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  extractKooCliTarGz,
  extractKooCliZip,
} from "../../src/koocli/archive.js";
import { kooCliTarGz, tarEntry } from "../fixtures/koocli-archive.js";

describe("KooCLI archive extraction", () => {
  it("extracts exactly one bounded Windows executable", () => {
    const executable = Buffer.from("windows hcloud fixture", "utf8");
    const archive = zipSync({
      "huaweicloud-cli/hcloud.exe": executable,
      "huaweicloud-cli/README.txt": Buffer.from("ignored", "utf8"),
    });

    expect(Buffer.from(extractKooCliZip(archive))).toEqual(executable);
  });

  it("rejects ZIP path traversal even on an ignored entry", () => {
    const archive = zipSync({
      "hcloud.exe": Buffer.from("fixture", "utf8"),
      "../outside.txt": Buffer.from("unsafe", "utf8"),
    });

    expect(() => extractKooCliZip(archive)).toThrowError(
      expect.objectContaining({ code: "KOOCLI_ARCHIVE_INVALID" }),
    );
  });

  it("extracts a checksum-verified tar.gz executable", () => {
    const executable = Buffer.from("posix hcloud fixture", "utf8");
    expect(Buffer.from(extractKooCliTarGz(kooCliTarGz(executable)))).toEqual(
      executable,
    );
  });

  it("rejects link entries in tar archives", () => {
    const entry = tarEntry("hcloud", new Uint8Array(), "2");
    const tar = new Uint8Array(entry.byteLength + 1024);
    tar.set(entry);

    expect(() => extractKooCliTarGz(gzipSync(tar))).toThrowError(
      expect.objectContaining({ code: "KOOCLI_ARCHIVE_INVALID" }),
    );
  });
});
