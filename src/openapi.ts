import { createHash, createHmac } from "node:crypto";

export type JsonObject = Record<string, unknown>;

interface Credentials {
  accessKey: string;
  secretKey: string;
}

const OBS_SIGNED_QUERY_PARAMETERS = new Set(["acl", "append", "cors", "customdomain", "delete", "inventory", "lifecycle", "location", "logging", "metadata", "mirrorback", "modify", "notification", "partNumber", "policy", "position", "quota", "rename", "replication", "requestPayment", "response-cache-control", "response-content-disposition", "response-content-encoding", "response-content-language", "response-content-type", "response-expires", "restore", "storageClass", "storageinfo", "tagging", "torrent", "uploadId", "uploads", "versionId", "versioning", "versions", "website"]);

function credentials(): Credentials {
  const accessKey = process.env.HUAWEICLOUD_AK ?? process.env.HUAWEICLOUD_SDK_AK;
  const secretKey = process.env.HUAWEICLOUD_SK ?? process.env.HUAWEICLOUD_SDK_SK;
  if (!accessKey || !secretKey) throw new Error("OpenAPI credentials are missing. Set HUAWEICLOUD_AK and HUAWEICLOUD_SK in the MCP server environment.");
  return { accessKey, secretKey };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(query: URLSearchParams): string {
  return [...query.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}

function sdkDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalSdkPath(pathname: string): string {
  return pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/") || "/";
}

export function signSdkRequest(method: string, url: URL, body = "", extraHeaders: Record<string, string> = {}, now = new Date()): Record<string, string> {
  const { accessKey, secretKey } = credentials();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-sdk-date": sdkDate(now),
    ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value.trim()])),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalUri = canonicalSdkPath(url.pathname);
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery(url.searchParams), canonicalHeaders, signedHeaderNames.join(";"), sha256(body)].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", headers["x-sdk-date"], sha256(canonicalRequest)].join("\n");
  headers.authorization = `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${hmacSha256(secretKey, stringToSign)}`;
  return headers;
}

export function signObsRequest(method: string, url: URL, now = new Date()): Record<string, string> {
  const { accessKey, secretKey } = credentials();
  const date = now.toUTCString();
  const bucketMarker = ".obs.";
  const markerIndex = url.hostname.indexOf(bucketMarker);
  const bucket = markerIndex > 0 ? url.hostname.slice(0, markerIndex) : "";
  const signedQuery = [...url.searchParams.entries()].filter(([key]) => OBS_SIGNED_QUERY_PARAMETERS.has(key)).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}${value ? `=${value}` : ""}`).join("&");
  const canonicalResource = `/${bucket}${url.pathname || "/"}${signedQuery ? `?${signedQuery}` : ""}`;
  const stringToSign = [method.toUpperCase(), "", "", date, canonicalResource].join("\n");
  const signature = createHmac("sha1", secretKey).update(stringToSign, "utf8").digest("base64");
  return { host: url.host, date, authorization: `OBS ${accessKey}:${signature}` };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = text;
  if (contentType.includes("application/json") && text) {
    try { body = JSON.parse(text); } catch { /* Preserve the original text. */ }
  }
  if (!response.ok) throw new Error(`Huawei Cloud API returned ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return { status: response.status, requestId: response.headers.get("x-request-id") ?? undefined, body };
}

async function responseMetadata(response: Response): Promise<unknown> {
  if (!response.ok) return responseBody(response);
  return {
    status: response.status,
    requestId: response.headers.get("x-obs-request-id") ?? response.headers.get("x-request-id") ?? undefined,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function region(input: JsonObject): string {
  const value = input.region ?? process.env.HUAWEICLOUD_REGION;
  if (typeof value !== "string" || !value) throw new Error("region is required. Provide input.region or HUAWEICLOUD_REGION.");
  return value;
}

function projectId(input: JsonObject): string {
  const value = input.projectId ?? process.env.HUAWEICLOUD_PROJECT_ID;
  if (typeof value !== "string" || !value) throw new Error("projectId is required. Provide input.projectId or HUAWEICLOUD_PROJECT_ID.");
  return value;
}

export async function listEcsServers(input: JsonObject): Promise<unknown> {
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/detail`, endpoint);
  if (typeof input.limit === "number") url.searchParams.set("limit", String(input.limit));
  if (typeof input.name === "string") url.searchParams.set("name", input.name);
  if (typeof input.status === "string") url.searchParams.set("status", input.status);
  const response = await fetch(url, { method: "GET", headers: signSdkRequest("GET", url) });
  return responseBody(response);
}

export async function getEcsServer(input: JsonObject): Promise<unknown> {
  if (typeof input.serverId !== "string" || !input.serverId) throw new Error("serverId is required.");
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/${encode(input.serverId)}`, endpoint);
  const response = await fetch(url, { method: "GET", headers: signSdkRequest("GET", url) });
  return responseBody(response);
}

export async function getEcsJob(input: JsonObject): Promise<unknown> {
  if (typeof input.jobId !== "string" || !input.jobId) throw new Error("jobId is required.");
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/jobs/${encode(input.jobId)}`, endpoint);
  const response = await fetch(url, { method: "GET", headers: signSdkRequest("GET", url) });
  return responseBody(response);
}

export async function startEcsServers(input: JsonObject): Promise<unknown> {
  if (!Array.isArray(input.serverIds) || input.serverIds.length === 0 || input.serverIds.length > 1000 || input.serverIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("serverIds must contain between 1 and 1000 ECS IDs.");
  }
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/action`, endpoint);
  const body = JSON.stringify({ "os-start": { servers: input.serverIds.map((id) => ({ id })) } });
  const response = await fetch(url, { method: "POST", headers: signSdkRequest("POST", url, body), body });
  return responseBody(response);
}

function serverIds(input: JsonObject): string[] {
  if (!Array.isArray(input.serverIds) || input.serverIds.length === 0 || input.serverIds.length > 1000 || input.serverIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("serverIds must contain between 1 and 1000 ECS IDs.");
  }
  return input.serverIds as string[];
}

function powerType(input: JsonObject, required: boolean): "SOFT" | "HARD" {
  const value = input.type ?? (required ? undefined : "SOFT");
  if (value !== "SOFT" && value !== "HARD") throw new Error("type must be SOFT or HARD.");
  return value;
}

async function ecsAction(input: JsonObject, body: JsonObject): Promise<unknown> {
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/action`, endpoint);
  const serializedBody = JSON.stringify(body);
  const response = await fetch(url, { method: "POST", headers: signSdkRequest("POST", url, serializedBody), body: serializedBody });
  return responseBody(response);
}

export async function stopEcsServers(input: JsonObject): Promise<unknown> {
  const servers = serverIds(input).map((id) => ({ id }));
  return ecsAction(input, { "os-stop": { type: powerType(input, false), servers } });
}

export async function rebootEcsServers(input: JsonObject): Promise<unknown> {
  const servers = serverIds(input).map((id) => ({ id }));
  return ecsAction(input, { reboot: { type: powerType(input, true), servers } });
}

export async function listObsBuckets(input: JsonObject): Promise<unknown> {
  const endpoint = `https://obs.${region(input)}.myhuaweicloud.com`;
  const url = new URL("/", endpoint);
  const response = await fetch(url, { method: "GET", headers: signObsRequest("GET", url) });
  return responseBody(response);
}

export async function getObsBucketMetadata(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/`);
  const response = await fetch(url, { method: "HEAD", headers: signObsRequest("HEAD", url) });
  return responseMetadata(response);
}

export async function getObsBucketLocation(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/?location`);
  const response = await fetch(url, { method: "GET", headers: signObsRequest("GET", url) });
  return responseBody(response);
}

export async function listObsObjects(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/`);
  if (typeof input.prefix === "string") url.searchParams.set("prefix", input.prefix);
  if (typeof input.marker === "string") url.searchParams.set("marker", input.marker);
  if (typeof input.delimiter === "string") url.searchParams.set("delimiter", input.delimiter);
  if (typeof input.maxKeys === "number") url.searchParams.set("max-keys", String(input.maxKeys));
  const response = await fetch(url, { method: "GET", headers: signObsRequest("GET", url) });
  return responseBody(response);
}

export async function getObsObjectMetadata(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  if (typeof input.key !== "string" || !input.key) throw new Error("key is required.");
  const objectPath = input.key.split("/").map(encode).join("/");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${objectPath}`);
  if (typeof input.versionId === "string") url.searchParams.set("versionId", input.versionId);
  const response = await fetch(url, { method: "HEAD", headers: signObsRequest("HEAD", url) });
  return responseMetadata(response);
}
