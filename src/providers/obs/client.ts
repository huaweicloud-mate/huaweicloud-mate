import { createHmac } from "node:crypto";

import { RouterError } from "../../router/errors.js";
import type { CredentialSecretInput } from "../../auth/types.js";
import { pluginVersion } from "../../version.js";

const maxResponseBytes = 1024 * 1024;
const maxObjectTextBytes = 64 * 1024;
const regionPattern = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u;

export interface ObsBucketSummary {
  readonly name: string;
  readonly creationDate: string;
  readonly location?: string;
  readonly type?: "OBJECT" | "POSIX";
}

export interface ObsListBucketsResult {
  readonly ownerAccountId: string;
  readonly buckets: readonly ObsBucketSummary[];
  readonly requestId?: string;
}

export interface ObsCreateBucketResult {
  readonly bucketName: string;
  readonly region: string;
  readonly location: string;
  readonly requestId?: string;
}

export interface ObsDeleteBucketResult {
  readonly bucketName: string;
  readonly region: string;
  readonly deleted: true;
  readonly requestId?: string;
}

export interface ObsGetObjectTextResult {
  readonly bucketName: string;
  readonly objectKey: string;
  readonly region: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly text: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly requestId?: string;
}

export interface ObsListBucketsOptions extends CredentialSecretInput {
  readonly region?: string;
  readonly signal?: AbortSignal;
}

export interface ObsCreateBucketOptions extends CredentialSecretInput {
  readonly bucketName: string;
  readonly region: string;
  readonly signal?: AbortSignal;
}

export interface ObsDeleteBucketOptions extends CredentialSecretInput {
  readonly bucketName: string;
  readonly region: string;
  readonly signal?: AbortSignal;
}

export interface ObsGetObjectTextOptions extends CredentialSecretInput {
  readonly bucketName: string;
  readonly objectKey: string;
  readonly region: string;
  readonly signal?: AbortSignal;
}

export interface ObsClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

function providerError(
  code: ConstructorParameters<typeof RouterError>[0],
  message: string,
  retryable = false,
): never {
  throw new RouterError(code, message, retryable);
}

function endpoint(region?: string): URL {
  if (region !== undefined && !regionPattern.test(region)) {
    return providerError("INVALID_SCOPE", "OBS region is invalid");
  }
  return new URL(
    region === undefined
      ? "https://obs.myhuaweicloud.com/"
      : `https://obs.${region}.myhuaweicloud.com/`,
  );
}

export function createObsRequestAuthorization(
  credentials: CredentialSecretInput,
  date: string,
  method: "GET" | "PUT" | "DELETE",
  contentType: string,
  resource = "/",
): string {
  const stringToSign = [method, "", contentType, date, resource].join("\n");
  const signature = createHmac("sha1", credentials.secretKey)
    .update(stringToSign, "utf8")
    .digest("base64");
  return `OBS ${credentials.accessKey}:${signature}`;
}

export function createObsAuthorization(
  credentials: CredentialSecretInput,
  date: string,
  resource = "/",
): string {
  return createObsRequestAuthorization(credentials, date, "GET", "", resource);
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/gu,
    (entity) => {
      switch (entity) {
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&amp;": return "&";
        case "&quot;": return '"';
        case "&apos;": return "'";
        default: {
          const hexadecimal = entity.startsWith("&#x");
          const digits = entity.slice(hexadecimal ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
          return Number.isSafeInteger(codePoint) &&
              codePoint > 0 && codePoint <= 0x10ffff &&
              !(codePoint >= 0xd800 && codePoint <= 0xdfff)
            ? String.fromCodePoint(codePoint)
            : providerError("OUTPUT_REJECTED", "OBS returned invalid XML text");
        }
      }
    },
  );
}

function element(block: string, name: string, required = true): string | undefined {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u"));
  if (match?.[1] === undefined) {
    return required
      ? providerError("OUTPUT_REJECTED", `OBS response is missing ${name}`)
      : undefined;
  }
  const raw = match[1];
  if (/<|&(?!(?:lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/u.test(raw)) {
    return providerError("OUTPUT_REJECTED", "OBS returned unsupported XML content");
  }
  const decoded = decodeXmlText(raw);
  if (decoded.length === 0 || decoded.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded)) {
    return providerError("OUTPUT_REJECTED", "OBS returned invalid XML content");
  }
  return decoded;
}

function withoutElements(block: string, names: readonly string[]): string {
  let residue = block;
  for (const name of names) {
    residue = residue.replace(
      new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "u"),
      "",
    );
  }
  return residue.trim();
}

export function parseObsListBucketsXml(xml: string): Omit<ObsListBucketsResult, "requestId"> {
  if (
    Buffer.byteLength(xml, "utf8") > maxResponseBytes ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?(?!xml\s)/iu.test(xml)
  ) {
    return providerError("OUTPUT_REJECTED", "OBS returned unsupported XML");
  }
  const root = xml.match(
    /<ListAllMyBucketsResult(?:\s+xmlns="[^"]{1,512}")?>([\s\S]*?)<\/ListAllMyBucketsResult>/u,
  );
  if (root?.[1] === undefined) {
    return providerError("OUTPUT_REJECTED", "OBS returned an invalid bucket list");
  }
  const ownerBlock = root[1].match(/<Owner>([\s\S]*?)<\/Owner>/u)?.[1];
  const bucketsBlock = root[1].match(/<Buckets>([\s\S]*?)<\/Buckets>/u)?.[1];
  if (ownerBlock === undefined || bucketsBlock === undefined) {
    return providerError("OUTPUT_REJECTED", "OBS returned an incomplete bucket list");
  }
  const ownerAccountId = element(ownerBlock, "ID")!;
  element(ownerBlock, "DisplayName", false);
  if (ownerAccountId.length > 256) {
    return providerError("OUTPUT_REJECTED", "OBS returned an invalid owner identity");
  }
  if (withoutElements(ownerBlock, ["ID", "DisplayName"]).length > 0) {
    return providerError("OUTPUT_REJECTED", "OBS returned unsupported owner metadata");
  }
  const buckets: ObsBucketSummary[] = [];
  const bucketPattern = /<Bucket>([\s\S]*?)<\/Bucket>/gu;
  for (const match of bucketsBlock.matchAll(bucketPattern)) {
    const block = match[1]!;
    const name = element(block, "Name")!;
    const creationDate = element(block, "CreationDate")!;
    const location = element(block, "Location", false);
    const type = element(block, "BucketType", false);
    if (
      buckets.length >= 10_000 ||
      name.length > 255 ||
      creationDate.length > 128 ||
      (location !== undefined && location.length > 128) ||
      (type !== undefined && type !== "OBJECT" && type !== "POSIX")
    ) {
      return providerError("OUTPUT_REJECTED", "OBS returned invalid bucket metadata");
    }
    if (
      withoutElements(block, ["Name", "CreationDate", "Location", "BucketType"]).length > 0
    ) {
      return providerError("OUTPUT_REJECTED", "OBS returned unsupported bucket metadata");
    }
    buckets.push({
      name,
      creationDate,
      ...(location === undefined ? {} : { location }),
      ...(type === undefined ? {} : { type }),
    });
  }
  const residue = bucketsBlock.replace(bucketPattern, "").trim();
  if (residue.length > 0) {
    return providerError("OUTPUT_REJECTED", "OBS returned unsupported bucket metadata");
  }
  return { ownerAccountId, buckets };
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return providerError("OUTPUT_REJECTED", "OBS response exceeds the size limit");
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) {
      break;
    }
    bytes += item.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return providerError("OUTPUT_REJECTED", "OBS response exceeds the size limit");
    }
    chunks.push(item.value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readLimitedText(response: Response): Promise<string> {
  const bytes = await readLimitedBytes(response, maxResponseBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return providerError("OUTPUT_REJECTED", "OBS response is not valid UTF-8");
  }
}

function errorCode(xml: string): string | undefined {
  try {
    return element(xml, "Code", false);
  } catch {
    return undefined;
  }
}

function validBucketName(bucketName: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(bucketName) &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucketName);
}

function validObjectKey(objectKey: string): boolean {
  return (
    objectKey.length > 0 &&
    Buffer.byteLength(objectKey, "utf8") <= 1024 &&
    !objectKey.startsWith("/") &&
    !objectKey.endsWith("/") &&
    !objectKey.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(objectKey) &&
    objectKey.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".."
    )
  );
}

function objectPath(objectKey: string): string {
  return `/${objectKey.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function allowedTextContentType(value: string | null): string {
  if (value === null || value.length === 0 || value.length > 256) {
    return providerError("OUTPUT_REJECTED", "OBS object content type is unavailable");
  }
  const [rawMediaType, ...parameters] = value
    .split(";")
    .map((part) => part.trim());
  const mediaType = rawMediaType?.toLowerCase();
  const allowed = new Set([
    "application/json",
    "application/xml",
    "text/csv",
    "text/plain",
    "text/xml",
  ]);
  if (
    mediaType === undefined ||
    !allowed.has(mediaType) ||
    parameters.some((parameter) => !/^charset=utf-8$/iu.test(parameter))
  ) {
    return providerError("OUTPUT_REJECTED", "OBS object content type is not allowed");
  }
  return parameters.length === 0 ? mediaType : `${mediaType}; charset=utf-8`;
}

function optionalHeader(
  response: Response,
  name: string,
): string | undefined {
  const value = response.headers.get(name) ?? undefined;
  if (
    value !== undefined &&
    (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    return providerError("OUTPUT_REJECTED", "OBS returned invalid object metadata");
  }
  return value;
}

export class ObsClient {
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: ObsClientOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      providerError("VALIDATION_FAILED", "OBS timeout is invalid");
    }
  }

  async listBuckets(options: ObsListBucketsOptions): Promise<ObsListBucketsResult> {
    const url = endpoint(options.region);
    const date = this.now().toUTCString();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          accept: "application/xml",
          authorization: createObsAuthorization(options, date),
          date,
          "user-agent": `huaweicloud-mate/${pluginVersion}`,
        },
      });
    } catch (error) {
      if (signal.aborted) {
        return providerError("UPSTREAM_TIMEOUT", "OBS request timed out or was cancelled", true);
      }
      return providerError("PROVIDER_UNAVAILABLE", "OBS could not be reached", true);
    }
    const xml = await readLimitedText(response);
    if (!response.ok) {
      const code = errorCode(xml);
      if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
        return providerError("AUTH_REQUIRED", "Huawei Cloud credentials were rejected");
      }
      if (response.status === 401 || response.status === 403) {
        return providerError("PERMISSION_DENIED", "OBS denied the bucket list request");
      }
      if (response.status === 429 || response.status === 503) {
        return providerError("RATE_LIMITED", "OBS is temporarily unavailable", true);
      }
      return providerError("PROVIDER_UNAVAILABLE", "OBS returned an unsuccessful response", response.status >= 500);
    }
    const parsed = parseObsListBucketsXml(xml);
    const requestId = response.headers.get("x-obs-request-id") ?? undefined;
    return { ...parsed, ...(requestId === undefined ? {} : { requestId }) };
  }

  async createBucket(options: ObsCreateBucketOptions): Promise<ObsCreateBucketResult> {
    if (!validBucketName(options.bucketName)) {
      return providerError("VALIDATION_FAILED", "OBS bucket name is invalid");
    }
    const base = endpoint(options.region);
    const url = new URL(`https://${options.bucketName}.${base.host}/`);
    const date = this.now().toUTCString();
    const contentType = "application/xml";
    const body = `<CreateBucketConfiguration xmlns="http://obs.${options.region}.myhuaweicloud.com/doc/2015-06-30/"><Location>${options.region}</Location></CreateBucketConfiguration>`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.request(url, {
        method: "PUT",
        body,
        redirect: "error",
        signal,
        headers: {
          authorization: createObsRequestAuthorization(
            options,
            date,
            "PUT",
            contentType,
            `/${options.bucketName}/`,
          ),
          "content-type": contentType,
          date,
          "user-agent": `huaweicloud-mate/${pluginVersion}`,
        },
      });
    } catch {
      if (signal.aborted) {
        return providerError(
          "OUTCOME_UNKNOWN",
          "OBS bucket creation timed out or was cancelled after dispatch",
        );
      }
      return providerError(
        "OUTCOME_UNKNOWN",
        "OBS bucket creation outcome could not be determined",
      );
    }
    let responseBody: string;
    try {
      responseBody = await readLimitedText(response);
    } catch {
      return providerError(
        "OUTCOME_UNKNOWN",
        "OBS bucket creation response could not be verified after dispatch",
      );
    }
    if (!response.ok) {
      const code = errorCode(responseBody);
      if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
        return providerError("AUTH_REQUIRED", "Huawei Cloud credentials were rejected");
      }
      if (response.status === 401 || response.status === 403) {
        return providerError("PERMISSION_DENIED", "OBS denied the bucket creation request");
      }
      if (response.status === 409) {
        return providerError("CONFLICT", "The OBS bucket name is unavailable");
      }
      if (response.status === 429 || response.status === 503) {
        return providerError("RATE_LIMITED", "OBS is temporarily unavailable", true);
      }
      return providerError(
        "PROVIDER_UNAVAILABLE",
        "OBS returned an unsuccessful bucket creation response",
        response.status >= 500,
      );
    }
    const requestId = response.headers.get("x-obs-request-id") ?? undefined;
    return {
      bucketName: options.bucketName,
      region: options.region,
      location: response.headers.get("location") ?? `/${options.bucketName}`,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  async getObjectText(
    options: ObsGetObjectTextOptions,
  ): Promise<ObsGetObjectTextResult> {
    if (!validBucketName(options.bucketName) || !validObjectKey(options.objectKey)) {
      return providerError("VALIDATION_FAILED", "OBS object location is invalid");
    }
    const base = endpoint(options.region);
    const encodedPath = objectPath(options.objectKey);
    const url = new URL(
      `https://${options.bucketName}.${base.host}${encodedPath}`,
    );
    const date = this.now().toUTCString();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          accept: "text/plain, application/json, application/xml, text/xml, text/csv",
          authorization: createObsAuthorization(
            options,
            date,
            `/${options.bucketName}/${options.objectKey}`,
          ),
          date,
          "user-agent": `huaweicloud-mate/${pluginVersion}`,
        },
      });
    } catch {
      return providerError(
        signal.aborted ? "UPSTREAM_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        signal.aborted
          ? "OBS object read timed out or was cancelled"
          : "OBS object could not be reached",
        true,
      );
    }
    if (!response.ok) {
      const errorBody = await readLimitedText(response);
      const code = errorCode(errorBody);
      if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
        return providerError("AUTH_REQUIRED", "Huawei Cloud credentials were rejected");
      }
      if (response.status === 401 || response.status === 403) {
        return providerError("PERMISSION_DENIED", "OBS denied the object read request");
      }
      if (response.status === 404 || code === "NoSuchBucket" || code === "NoSuchKey") {
        return providerError("CONFLICT", "The OBS object does not exist");
      }
      if (response.status === 429 || response.status === 503) {
        return providerError("RATE_LIMITED", "OBS is temporarily unavailable", true);
      }
      return providerError(
        "PROVIDER_UNAVAILABLE",
        "OBS returned an unsuccessful object response",
        response.status >= 500,
      );
    }
    if (
      response.headers.get("content-encoding") !== null &&
      response.headers.get("content-encoding")?.toLowerCase() !== "identity"
    ) {
      return providerError("OUTPUT_REJECTED", "Encoded OBS object content is not allowed");
    }
    const contentType = allowedTextContentType(
      response.headers.get("content-type"),
    );
    const bytes = await readLimitedBytes(response, maxObjectTextBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return providerError("OUTPUT_REJECTED", "OBS object is not valid UTF-8 text");
    }
    const etag = optionalHeader(response, "etag");
    const lastModified = optionalHeader(response, "last-modified");
    const requestId = optionalHeader(response, "x-obs-request-id");
    return {
      bucketName: options.bucketName,
      objectKey: options.objectKey,
      region: options.region,
      contentType,
      contentLength: bytes.byteLength,
      text,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  async deleteBucket(options: ObsDeleteBucketOptions): Promise<ObsDeleteBucketResult> {
    if (!validBucketName(options.bucketName)) {
      return providerError("VALIDATION_FAILED", "OBS bucket name is invalid");
    }
    const base = endpoint(options.region);
    const url = new URL(`https://${options.bucketName}.${base.host}/`);
    const date = this.now().toUTCString();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.request(url, {
        method: "DELETE",
        redirect: "error",
        signal,
        headers: {
          authorization: createObsRequestAuthorization(
            options,
            date,
            "DELETE",
            "",
            `/${options.bucketName}/`,
          ),
          date,
          "user-agent": `huaweicloud-mate/${pluginVersion}`,
        },
      });
    } catch {
      return providerError(
        "OUTCOME_UNKNOWN",
        signal.aborted
          ? "OBS bucket deletion timed out or was cancelled after dispatch"
          : "OBS bucket deletion outcome could not be determined",
      );
    }
    let responseBody: string;
    try {
      responseBody = await readLimitedText(response);
    } catch {
      return providerError(
        "OUTCOME_UNKNOWN",
        "OBS bucket deletion response could not be verified after dispatch",
      );
    }
    if (!response.ok) {
      const code = errorCode(responseBody);
      if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") {
        return providerError("AUTH_REQUIRED", "Huawei Cloud credentials were rejected");
      }
      if (response.status === 401 || response.status === 403) {
        return providerError("PERMISSION_DENIED", "OBS denied the bucket deletion request");
      }
      if (
        response.status === 404 ||
        response.status === 409 ||
        code === "NoSuchBucket" ||
        code === "BucketNotEmpty"
      ) {
        return providerError(
          "CONFLICT",
          code === "BucketNotEmpty"
            ? "The OBS bucket is not empty"
            : "The OBS bucket cannot be deleted in its current state",
        );
      }
      if (response.status === 429 || response.status === 503) {
        return providerError("RATE_LIMITED", "OBS is temporarily unavailable", true);
      }
      return providerError(
        "PROVIDER_UNAVAILABLE",
        "OBS returned an unsuccessful bucket deletion response",
        response.status >= 500,
      );
    }
    const requestId = response.headers.get("x-obs-request-id") ?? undefined;
    return {
      bucketName: options.bucketName,
      region: options.region,
      deleted: true,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}
