import { loadObsEnv, requireCredentials, type ObsEnv } from "../config/env.js";
import type { OperationSpec } from "../operations/types.js";
import { resolveEndpoint } from "./endpoint.js";
import { readBodyFromArgs, persistOrPreviewResponse } from "./stream.js";
import { signObsRequest } from "./signer.js";
import { buildXml, parseXml } from "./xml.js";

export interface ObsCallResult {
  operation: string;
  request: {
    method: string;
    url: string;
  };
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export class ObsRestClient {
  constructor(private readonly env: ObsEnv = loadObsEnv()) {}

  async call(spec: OperationSpec, args: Record<string, unknown>): Promise<ObsCallResult> {
    const credentials = requireCredentials(this.env);
    const query = normalizeRecord(args.query);
    if (spec.subresource) {
      query[spec.subresource] = "";
    }

    for (const key of spec.extraQueryKeys ?? []) {
      if (args[key] !== undefined) {
        query[key] = args[key];
      }
    }

    const bucket = typeof args.bucket === "string" ? args.bucket : undefined;
    const key = typeof args.key === "string" ? args.key : undefined;
    const url = resolveEndpoint({
      region: stringArg(args.region) ?? this.env.region,
      endpoint: stringArg(args.endpoint) ?? this.env.endpoint,
      bucket: spec.pathKind === "service" ? undefined : bucket,
      key: spec.pathKind === "object" ? key : undefined,
      query
    });

    const headers = buildHeaders(args, spec);
    const body = await buildBody(args, spec);
    if (spec.responseKind === "binary" && typeof args.outputPath !== "string" && !headers.Range && !headers.range) {
      headers.Range = `bytes=0-${Math.max(0, this.env.previewBytes - 1)}`;
    }

    const signedHeaders = signObsRequest({
      method: spec.method,
      url,
      headers,
      ...credentials,
      securityToken: this.env.securityToken
    });

    const response = await fetch(url, {
      method: spec.method,
      headers: signedHeaders,
      body: spec.method === "GET" || spec.method === "HEAD" ? undefined : body
    });

    const responseHeaders = Object.fromEntries(response.headers.entries());
    const result: ObsCallResult = {
      operation: spec.apiName,
      request: {
        method: spec.method,
        url: redactUrl(url)
      },
      status: response.status,
      headers: responseHeaders
    };

    if (!response.ok) {
      result.body = await parseErrorBody(response);
      throw new Error(JSON.stringify(result, null, 2));
    }

    result.body = await parseSuccessBody(response, spec, args, this.env.previewBytes);
    return result;
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildHeaders(args: Record<string, unknown>, spec: OperationSpec): Record<string, string> {
  const headers: Record<string, string> = {
    Date: new Date().toUTCString()
  };
  for (const [key, value] of Object.entries(normalizeRecord(args.headers))) {
    headers[key] = String(value);
  }
  if (typeof args.contentType === "string") {
    headers["Content-Type"] = args.contentType;
  } else if (spec.bodyKind === "xml") {
    headers["Content-Type"] = "application/xml";
  } else if (spec.bodyKind === "json") {
    headers["Content-Type"] = "application/json";
  }
  if (typeof args.range === "string") {
    headers.Range = args.range;
  }
  for (const [key, value] of Object.entries(normalizeRecord(args.metadata))) {
    headers[`x-obs-meta-${key}`] = String(value);
  }
  return headers;
}

async function buildBody(args: Record<string, unknown>, spec: OperationSpec): Promise<BodyInit | undefined> {
  if (spec.bodyKind === "xml" && args.bodyJson !== undefined) {
    return buildXml(args.bodyJson);
  }
  return readBodyFromArgs(args);
}

async function parseSuccessBody(response: Response, spec: OperationSpec, args: Record<string, unknown>, previewBytes: number): Promise<unknown> {
  if (spec.responseKind === "empty" || response.status === 204 || spec.method === "HEAD") {
    return {};
  }
  if (spec.responseKind === "binary") {
    return persistOrPreviewResponse(response, args.outputPath, previewBytes);
  }
  const text = await response.text();
  if (spec.responseKind === "xml") {
    return parseXml(text);
  }
  return text;
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return parseXml(text);
  } catch {
    return text;
  }
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  for (const key of ["AWSAccessKeyId", "Signature", "security-token"]) {
    if (safe.searchParams.has(key)) {
      safe.searchParams.set(key, "[redacted]");
    }
  }
  return safe.toString();
}
