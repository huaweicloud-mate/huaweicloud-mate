import { gzipSync } from "node:zlib";

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  target.set(Buffer.from(value, "ascii"), offset);
}

export function tarEntry(
  name: string,
  content: Uint8Array,
  type = "0",
): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, name);
  writeAscii(header, 100, "0000755\0");
  writeAscii(header, 108, "0000000\0");
  writeAscii(header, 116, "0000000\0");
  writeAscii(header, 124, `${content.byteLength.toString(8).padStart(11, "0")}\0`);
  writeAscii(header, 136, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, type);
  writeAscii(header, 257, "ustar\0");
  writeAscii(header, 263, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(content.byteLength / 512) * 512;
  const entry = new Uint8Array(512 + padded);
  entry.set(header);
  entry.set(content, 512);
  return entry;
}

export function kooCliTarGz(content: Uint8Array): Uint8Array {
  const entry = tarEntry("huaweicloud-cli/hcloud", content);
  const tar = new Uint8Array(entry.byteLength + 1024);
  tar.set(entry);
  return gzipSync(tar);
}
