import { readFile, writeFile } from "node:fs/promises";

export async function readBodyFromArgs(args: Record<string, unknown>): Promise<BodyInit | undefined> {
  if (typeof args.filePath === "string" && args.filePath.length > 0) {
    return readFile(args.filePath);
  }
  if (typeof args.body === "string") {
    return args.body;
  }
  if (args.bodyJson !== undefined) {
    return JSON.stringify(args.bodyJson);
  }
  if (typeof args.bodyXml === "string") {
    return args.bodyXml;
  }
  return undefined;
}

export async function persistOrPreviewResponse(response: Response, outputPath: unknown, previewBytes: number): Promise<Record<string, unknown>> {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (typeof outputPath === "string" && outputPath.length > 0) {
    await writeFile(outputPath, buffer);
    return {
      outputPath,
      bytesWritten: buffer.byteLength
    };
  }

  const preview = buffer.subarray(0, previewBytes);
  const contentType = response.headers.get("content-type") ?? "";
  const textLike = /^text\//i.test(contentType) || /json|xml|csv|html/i.test(contentType);
  return {
    bytesReceived: buffer.byteLength,
    previewBytes: preview.byteLength,
    truncated: buffer.byteLength > preview.byteLength,
    encoding: textLike ? "utf8" : "base64",
    preview: textLike ? preview.toString("utf8") : preview.toString("base64")
  };
}
