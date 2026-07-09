import type { JSONSchema7 } from "../utils/json-schema.js";
import type { BodyKind, OperationSpec } from "./types.js";

const stringField = (description: string): JSONSchema7 => ({ type: "string", description });
const objectField = (description: string): JSONSchema7 => ({ type: "object", description, additionalProperties: true });

export interface SchemaOptions {
  pathKind: OperationSpec["pathKind"];
  bodyKind: BodyKind;
  requiresConfirm?: OperationSpec["requiresConfirm"];
  includeRange?: boolean;
  includeOutputPath?: boolean;
}

export function makeInputSchema(options: SchemaOptions): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {
    region: stringField("Optional OBS region override, for example cn-north-4."),
    endpoint: stringField("Optional OBS endpoint override, for example https://obs.cn-north-4.myhuaweicloud.com."),
    query: objectField("Additional query parameters to send to OBS."),
    headers: objectField("Additional request headers to send to OBS."),
    contentType: stringField("Optional Content-Type request header.")
  };
  const required: string[] = [];

  if (options.pathKind === "bucket" || options.pathKind === "object") {
    properties.bucket = stringField("OBS bucket name.");
    required.push("bucket");
  }
  if (options.pathKind === "object") {
    properties.key = stringField("OBS object key.");
    required.push("key");
  }
  if (options.bodyKind !== "none") {
    properties.body = stringField("Raw string request body. XML APIs may pass XML here.");
    properties.bodyJson = objectField("Structured body. XML APIs convert this object to XML.");
    properties.bodyXml = stringField("Raw XML request body.");
    properties.filePath = stringField("Local file path to upload as request body.");
  }
  if (options.includeRange) {
    properties.range = stringField("HTTP Range header, for example bytes=0-1023.");
  }
  if (options.includeOutputPath) {
    properties.outputPath = stringField("Local file path where downloaded object content will be written.");
  }
  if (options.requiresConfirm) {
    properties.confirm = stringField("Required confirmation token. For bucket operations use bucket; for object operations use bucket/key.");
    required.push("confirm");
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}
