import type { JSONSchema7 } from "../utils/json-schema.js";

export type OperationRisk = "read" | "write" | "delete" | "config_write" | "destructive";

export type OperationGroup =
  | "bucket_read"
  | "bucket_basic"
  | "bucket_config_xml"
  | "dangerous_bucket_config"
  | "object_read"
  | "object_write"
  | "object_delete_danger"
  | "multipart_large"
  | "website_cors_options"
  | "special_posix_pfs";

export type BodyKind = "none" | "text" | "json" | "xml" | "file";

export interface OperationSpec {
  apiName: string;
  toolName: string;
  title: string;
  description: string;
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD" | "OPTIONS";
  pathKind: "service" | "bucket" | "object";
  group: OperationGroup;
  risk: OperationRisk;
  docsUrl: string;
  aliases?: string[];
  subresource?: string;
  extraQueryKeys?: string[];
  bodyKind: BodyKind;
  responseKind: "headers" | "xml" | "text" | "binary" | "empty";
  inputSchema: JSONSchema7;
  requiresConfirm?: "bucket" | "object" | "bucket_or_object";
}
