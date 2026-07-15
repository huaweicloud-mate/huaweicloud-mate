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

export function signObsRequest(method: string, url: URL, extraHeadersOrNow: Record<string, string> | Date = {}, suppliedNow = new Date()): Record<string, string> {
  const { accessKey, secretKey } = credentials();
  const now = extraHeadersOrNow instanceof Date ? extraHeadersOrNow : suppliedNow;
  const suppliedHeaders = extraHeadersOrNow instanceof Date ? {} : extraHeadersOrNow;
  const headers = Object.fromEntries(Object.entries(suppliedHeaders).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const date = now.toUTCString();
  const bucketMarker = ".obs.";
  const markerIndex = url.hostname.indexOf(bucketMarker);
  const bucket = markerIndex > 0 ? url.hostname.slice(0, markerIndex) : "";
  const signedQuery = [...url.searchParams.entries()].filter(([key]) => OBS_SIGNED_QUERY_PARAMETERS.has(key)).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}${value ? `=${value}` : ""}`).join("&");
  const canonicalResource = `/${bucket}${url.pathname || "/"}${signedQuery ? `?${signedQuery}` : ""}`;
  const canonicalHeaders = Object.entries(headers).filter(([name]) => name.startsWith("x-obs-")).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value}\n`).join("");
  const effectiveDate = headers["x-obs-date"] ? "" : date;
  const stringToSign = [method.toUpperCase(), headers["content-md5"] ?? "", headers["content-type"] ?? "", effectiveDate, `${canonicalHeaders}${canonicalResource}`].join("\n");
  const signature = createHmac("sha1", secretKey).update(stringToSign, "utf8").digest("base64");
  return { host: url.host, date, ...headers, authorization: `OBS ${accessKey}:${signature}` };
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

async function responseObjectContent(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) return responseBody(response);
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) throw new Error(`OBS returned ${advertisedLength} bytes, exceeding maxBytes=${maxBytes}.`);
  const content = Buffer.from(await response.arrayBuffer());
  if (content.byteLength > maxBytes) throw new Error(`OBS returned ${content.byteLength} bytes, exceeding maxBytes=${maxBytes}.`);
  return {
    status: response.status,
    requestId: response.headers.get("x-obs-request-id") ?? response.headers.get("x-request-id") ?? undefined,
    headers: Object.fromEntries(response.headers.entries()),
    contentBase64: content.toString("base64"),
  };
}

async function responseCopyResult(response: Response): Promise<unknown> {
  if (!response.ok) return responseBody(response);
  const body = await response.text();
  const etag = body.match(/<ETag>([^<]+)<\/ETag>/)?.[1];
  if (!etag) throw new Error("OBS CopyObject did not return an ETag in its response body.");
  return {
    status: response.status,
    requestId: response.headers.get("x-obs-request-id") ?? response.headers.get("x-request-id") ?? undefined,
    etag,
    body,
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

const OPENAPI_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

function requestMethod(input: JsonObject): string {
  if (typeof input.method !== "string" || !OPENAPI_METHODS.has(input.method)) throw new Error("method must be one of GET, HEAD, POST, PUT, PATCH, DELETE.");
  return input.method;
}

function objectValue(input: JsonObject, name: string): JsonObject | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as JsonObject;
}

function applyQuery(url: URL, value: JsonObject | undefined): void {
  if (!value) return;
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error(`query.${name} must be a string, number, or boolean.`);
    url.searchParams.set(name, String(item));
  }
}

function genericResponseLimit(input: JsonObject): number {
  const value = input.maxResponseBytes ?? 1024 * 1024;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) throw new Error("maxResponseBytes must be an integer between 1 and 1048576.");
  return value;
}

async function responseGeneric(response: Response, maxBytes: number): Promise<unknown> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) throw new Error(`Huawei Cloud API returned ${advertisedLength} bytes, exceeding maxResponseBytes=${maxBytes}.`);
  const content = Buffer.from(await response.arrayBuffer());
  if (content.byteLength > maxBytes) throw new Error(`Huawei Cloud API returned ${content.byteLength} bytes, exceeding maxResponseBytes=${maxBytes}.`);
  const contentType = response.headers.get("content-type") ?? "";
  const text = content.toString("utf8");
  let body: unknown = text;
  if (contentType.includes("application/json") && text) {
    try { body = JSON.parse(text); } catch { /* Preserve invalid JSON text for diagnostics. */ }
  } else if (!contentType.includes("json") && !contentType.startsWith("text/") && !contentType.includes("xml")) {
    body = undefined;
  }
  if (!response.ok) throw new Error(`Huawei Cloud API returned ${response.status}: ${body === undefined ? content.toString("base64") : typeof body === "string" ? body : JSON.stringify(body)}`);
  return {
    status: response.status,
    requestId: response.headers.get("x-obs-request-id") ?? response.headers.get("x-request-id") ?? undefined,
    headers: Object.fromEntries(response.headers.entries()),
    ...(body === undefined ? { bodyBase64: content.toString("base64") } : { body }),
  };
}

export async function callEcsOpenApi(input: JsonObject): Promise<unknown> {
  const method = requestMethod(input);
  if (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("?") || input.path.includes("#") || input.path.split("/").includes("..")) throw new Error("path must be an ECS API path beginning with one slash and without query, fragment, or '..' segments.");
  const path = input.path.includes("{project_id}") || input.path.includes("{projectId}")
    ? input.path.replaceAll("{project_id}", encode(projectId(input))).replaceAll("{projectId}", encode(projectId(input)))
    : input.path;
  const url = new URL(path, `https://ecs.${region(input)}.myhuaweicloud.com`);
  applyQuery(url, objectValue(input, "query"));
  if ((method === "GET" || method === "HEAD") && input.body !== undefined) throw new Error(`${method} requests cannot include body.`);
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  if (body === undefined) throw new Error("body must be JSON-serializable.");
  const response = await fetch(url, { method, headers: signSdkRequest(method, url, body), ...(body ? { body } : {}) });
  return responseGeneric(response, genericResponseLimit(input));
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

export async function listEcsFlavors(input: JsonObject): Promise<unknown> {
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/flavors`, endpoint);
  if (typeof input.availabilityZone === "string") url.searchParams.set("availability_zone", input.availabilityZone);
  if (typeof input.limit === "number") url.searchParams.set("limit", String(input.limit));
  if (typeof input.marker === "string") url.searchParams.set("marker", input.marker);
  const response = await fetch(url, { method: "GET", headers: signSdkRequest("GET", url) });
  return responseBody(response);
}

export async function listEcsAvailabilityZones(input: JsonObject): Promise<unknown> {
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/availability-zones`, endpoint);
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

export async function deleteEcsServers(input: JsonObject): Promise<unknown> {
  if (input.deletePublicIp !== undefined && typeof input.deletePublicIp !== "boolean") throw new Error("deletePublicIp must be a boolean.");
  if (input.deleteVolume !== undefined && typeof input.deleteVolume !== "boolean") throw new Error("deleteVolume must be a boolean.");
  const endpoint = `https://ecs.${region(input)}.myhuaweicloud.com`;
  const url = new URL(`/v1/${encode(projectId(input))}/cloudservers/delete`, endpoint);
  const body = JSON.stringify({ servers: serverIds(input).map((id) => ({ id })), delete_publicip: input.deletePublicIp ?? false, delete_volume: input.deleteVolume ?? false });
  const response = await fetch(url, { method: "POST", headers: signSdkRequest("POST", url, body), body });
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

export async function deleteObsBucket(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/`);
  const response = await fetch(url, { method: "DELETE", headers: signObsRequest("DELETE", url) });
  return responseMetadata(response);
}

export async function createObsBucket(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  const bucketRegion = region(input);
  const url = new URL(`https://${input.bucket}.obs.${bucketRegion}.myhuaweicloud.com/`);
  const body = `<CreateBucketConfiguration xmlns="http://obs.${bucketRegion}.myhuaweicloud.com/doc/2015-06-30/"><Location>${bucketRegion}</Location></CreateBucketConfiguration>`;
  const headers = signObsRequest("PUT", url, { "content-type": "application/xml" });
  const response = await fetch(url, { method: "PUT", headers, body });
  return responseMetadata(response);
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("contentBase64 must be a valid base64 string.");
  return Buffer.from(value, "base64");
}

function obsHeaders(input: JsonObject): Record<string, string> {
  const supplied = objectValue(input, "headers");
  if (!supplied) return {};
  const permitted = new Set(["content-type", "content-md5", "range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "cache-control", "content-disposition", "content-encoding", "content-language", "expires"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    const normalized = name.toLowerCase();
    if ((normalized !== "x-obs-" && !normalized.startsWith("x-obs-")) && !permitted.has(normalized)) throw new Error(`headers.${name} is not permitted.`);
    if (["authorization", "date", "host", "content-length"].includes(normalized) || normalized.includes("customer-key")) throw new Error(`headers.${name} is managed by the gateway or contains a secret and cannot be supplied.`);
    if (typeof value !== "string") throw new Error(`headers.${name} must be a string.`);
    result[normalized] = value;
  }
  return result;
}

export async function callObsOpenApi(input: JsonObject): Promise<unknown> {
  const method = requestMethod(input);
  const bucket = input.bucket;
  const key = input.key;
  if (bucket !== undefined && (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))) throw new Error("bucket must be a valid OBS bucket name.");
  if (key !== undefined && (typeof key !== "string" || !key)) throw new Error("key must be a non-empty string.");
  if (bucket === undefined && key !== undefined) throw new Error("bucket is required when key is supplied.");
  const objectPath = typeof key === "string" ? `/${key.split("/").map(encode).join("/")}` : "/";
  const url = new URL(bucket ? `https://${bucket}.obs.${region(input)}.myhuaweicloud.com${objectPath}` : `https://obs.${region(input)}.myhuaweicloud.com/`);
  applyQuery(url, objectValue(input, "query"));
  const headers = obsHeaders(input);
  const maxBytes = genericResponseLimit(input);
  if (method === "GET" && typeof key === "string" && !headers.range) headers.range = `bytes=0-${maxBytes - 1}`;
  let requestBody: Uint8Array<ArrayBuffer> | undefined;
  if (input.contentBase64 !== undefined) {
    if (method === "GET" || method === "HEAD") throw new Error(`${method} requests cannot include contentBase64.`);
    const content = decodeBase64(input.contentBase64);
    headers["content-md5"] = createHash("md5").update(content).digest("base64");
    headers["content-type"] ??= "application/octet-stream";
    requestBody = new Uint8Array(content.byteLength);
    requestBody.set(content);
  }
  const response = await fetch(url, { method, headers: signObsRequest(method, url, headers), ...(requestBody ? { body: requestBody } : {}) });
  return method === "HEAD" ? responseMetadata(response) : responseGeneric(response, maxBytes);
}

export async function appendObsObject(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  if (typeof input.key !== "string" || !input.key) throw new Error("key is required.");
  if (typeof input.position !== "number" || !Number.isSafeInteger(input.position) || input.position < 0) throw new Error("position must be a non-negative integer.");
  if (input.contentType !== undefined && typeof input.contentType !== "string") throw new Error("contentType must be a string.");
  const body = decodeBase64(input.contentBase64);
  const objectPath = input.key.split("/").map(encode).join("/");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${objectPath}?append&position=${input.position}`);
  const headers = signObsRequest("POST", url, { "content-type": typeof input.contentType === "string" ? input.contentType : "application/octet-stream", "content-md5": createHash("md5").update(body).digest("base64") });
  const requestBody = new Uint8Array(body.byteLength);
  requestBody.set(body);
  const response = await fetch(url, { method: "POST", headers, body: requestBody });
  return responseMetadata(response);
}

export async function putObsObject(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  if (typeof input.key !== "string" || !input.key) throw new Error("key is required.");
  if (input.contentType !== undefined && typeof input.contentType !== "string") throw new Error("contentType must be a string.");
  const body = decodeBase64(input.contentBase64);
  const objectPath = input.key.split("/").map(encode).join("/");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${objectPath}`);
  const headers = signObsRequest("PUT", url, { "content-type": typeof input.contentType === "string" ? input.contentType : "application/octet-stream", "content-md5": createHash("md5").update(body).digest("base64") });
  const requestBody = new Uint8Array(body.byteLength);
  requestBody.set(body);
  const response = await fetch(url, { method: "PUT", headers, body: requestBody });
  return responseMetadata(response);
}

export async function copyObsObject(input: JsonObject): Promise<unknown> {
  for (const name of ["bucket", "key", "sourceBucket", "sourceKey"] as const) if (typeof input[name] !== "string" || !input[name]) throw new Error(`${name} is required.`);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket as string) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.sourceBucket as string)) throw new Error("bucket and sourceBucket must be valid OBS bucket names.");
  if (input.sourceVersionId !== undefined && typeof input.sourceVersionId !== "string") throw new Error("sourceVersionId must be a string.");
  const targetPath = (input.key as string).split("/").map(encode).join("/");
  const sourcePath = (input.sourceKey as string).split("/").map(encode).join("/");
  const sourceVersion = typeof input.sourceVersionId === "string" ? `?versionId=${encode(input.sourceVersionId)}` : "";
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${targetPath}`);
  const headers = signObsRequest("PUT", url, { "x-obs-copy-source": `/${input.sourceBucket}/${sourcePath}${sourceVersion}` });
  const response = await fetch(url, { method: "PUT", headers });
  return responseCopyResult(response);
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

export async function getObsObject(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  if (typeof input.key !== "string" || !input.key) throw new Error("key is required.");
  if (typeof input.maxBytes !== "number" || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1024 * 1024) throw new Error("maxBytes must be an integer between 1 and 1048576.");
  const objectPath = input.key.split("/").map(encode).join("/");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${objectPath}`);
  if (typeof input.versionId === "string") url.searchParams.set("versionId", input.versionId);
  const response = await fetch(url, { method: "GET", headers: signObsRequest("GET", url, { range: `bytes=0-${input.maxBytes - 1}` }) });
  return responseObjectContent(response, input.maxBytes);
}

export async function deleteObsObject(input: JsonObject): Promise<unknown> {
  if (typeof input.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("bucket must be a valid OBS bucket name.");
  if (typeof input.key !== "string" || !input.key) throw new Error("key is required.");
  const objectPath = input.key.split("/").map(encode).join("/");
  const url = new URL(`https://${input.bucket}.obs.${region(input)}.myhuaweicloud.com/${objectPath}`);
  if (typeof input.versionId === "string") url.searchParams.set("versionId", input.versionId);
  const response = await fetch(url, { method: "DELETE", headers: signObsRequest("DELETE", url) });
  return responseMetadata(response);
}
