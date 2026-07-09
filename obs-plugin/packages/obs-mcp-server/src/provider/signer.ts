import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
}

const subresourceKeys = new Set([
  "acl",
  "append",
  "attname",
  "cors",
  "customdomain",
  "delete",
  "directcoldaccess",
  "encryption",
  "inventory",
  "length",
  "lifecycle",
  "location",
  "logging",
  "metadata",
  "mirrorBackToSource",
  "modify",
  "notification",
  "obscompresspolicy",
  "object-lock",
  "partNumber",
  "policy",
  "position",
  "publicAccessBlock",
  "quota",
  "rename",
  "replication",
  "response-cache-control",
  "response-content-disposition",
  "response-content-encoding",
  "response-content-language",
  "response-content-type",
  "response-expires",
  "restore",
  "storageClass",
  "storageinfo",
  "tagging",
  "truncate",
  "uploadId",
  "uploads",
  "versionId",
  "versioning",
  "versions",
  "website",
  "wormPolicy"
]);

export function signObsRequest(input: SignInput): Record<string, string> {
  const headers = normalizeHeaders(input.headers);
  if (!headers.date) {
    headers.date = new Date().toUTCString();
  }
  if (input.securityToken) {
    headers["x-obs-security-token"] = input.securityToken;
  }

  const stringToSign = buildStringToSign(input.method, input.url, headers);
  const signature = createHmac("sha1", input.secretAccessKey).update(stringToSign).digest("base64");
  headers.authorization = `OBS ${input.accessKeyId}:${signature}`;
  return restoreHeaderCase(headers);
}

export function buildStringToSign(method: string, url: URL, headers: Record<string, string>): string {
  const normalized = normalizeHeaders(headers);
  const contentMd5 = normalized["content-md5"] ?? "";
  const contentType = normalized["content-type"] ?? "";
  const date = hasObsDate(normalized) ? "" : normalized.date ?? "";
  const canonicalHeaders = canonicalObsHeaders(normalized);
  const canonicalResource = canonicalObsResource(url);
  return [method.toUpperCase(), contentMd5, contentType, date, canonicalHeaders + canonicalResource].join("\n");
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value).trim();
  }
  return normalized;
}

function restoreHeaderCase(headers: Record<string, string>): Record<string, string> {
  const restored: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    restored[key] = value;
  }
  return restored;
}

function hasObsDate(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.startsWith("x-obs-date"));
}

function canonicalObsHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([key]) => key.startsWith("x-obs-"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value.replace(/\s+/g, " ")}`)
    .join("\n")
    .replace(/^(.*)$/, (value) => (value ? `${value}\n` : ""));
}

function canonicalObsResource(url: URL): string {
  const path = url.pathname || "/";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => subresourceKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => (value === "" ? key : `${key}=${value}`));
  return params.length > 0 ? `${path}?${params.join("&")}` : path;
}
