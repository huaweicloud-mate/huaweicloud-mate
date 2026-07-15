import ecsCatalogJson from "./generated/ecs-catalog.json";
import obsCatalogJson from "./generated/obs-catalog.json";
import catalogManifestJson from "./generated/catalog-manifest.json";
import { callEcsOpenApi, callObsOpenApi, type JsonObject } from "./openapi";
import type { SubMcpOperation } from "./submcp/types";

interface EcsCatalogEntry {
  id: string;
  apiName: string;
  method: string;
  path: string;
  description: string;
  required: string[];
  pathParameters: Record<string, string>;
  queryParameters: Record<string, string>;
  inputNames: string[];
}

interface ObsParameter {
  required?: boolean;
  location?: string;
  sentAs?: string;
  withPrefix?: boolean;
  type?: string;
}

interface ObsCatalogEntry {
  id: string;
  apiName: string;
  method: string;
  description: string;
  parameters: Record<string, ObsParameter>;
}

const ecsCatalog = ecsCatalogJson as unknown as EcsCatalogEntry[];
const obsCatalog = obsCatalogJson as unknown as ObsCatalogEntry[];
const API_EXPLORER = "https://console.huaweicloud.com/apiexplorer/#/openapi";

function sourceUrl(service: "ECS" | "OBS", apiName: string): string {
  return `${API_EXPLORER}/${service}/doc?api=${encodeURIComponent(apiName)}`;
}

function isReadOnly(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function generatedSchema(names: string[], required: string[]): JsonObject {
  const properties: JsonObject = {
    region: { type: "string" },
    projectId: { type: "string" },
  };
  for (const name of names) properties[name] = name === "body" ? {} : {};
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function primitiveQueryValue(value: unknown, name: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`${name} must be a string, number, or boolean.`);
}

async function callGeneratedEcs(entry: EcsCatalogEntry, input: JsonObject): Promise<unknown> {
  let path = entry.path;
  for (const [placeholder, inputName] of Object.entries(entry.pathParameters)) {
    const value = input[inputName];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`${inputName} must be a string or number.`);
    path = path.replaceAll(`{${placeholder}}`, encodeURIComponent(String(value)));
  }
  const query: JsonObject = {};
  for (const [queryName, inputName] of Object.entries(entry.queryParameters)) {
    if (input[inputName] !== undefined) query[queryName] = primitiveQueryValue(input[inputName], inputName);
  }
  return callEcsOpenApi({ method: entry.method, path, ...(Object.keys(query).length ? { query } : {}), ...(input.body === undefined ? {} : { body: input.body }), ...(typeof input.region === "string" ? { region: input.region } : {}), ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}) });
}

function obsHeaderName(name: string, parameter: ObsParameter): string {
  const sentAs = parameter.sentAs ?? name;
  if (!parameter.withPrefix) return sentAs;
  return sentAs.startsWith("x-obs-") ? sentAs : `x-obs-${sentAs}`;
}

async function callGeneratedObs(entry: ObsCatalogEntry, input: JsonObject): Promise<unknown> {
  const query: JsonObject = {};
  const headers: JsonObject = {};
  let bucket: unknown = input.bucket ?? input.Bucket;
  let key: unknown = input.key ?? input.Key;
  for (const [name, parameter] of Object.entries(entry.parameters)) {
    const value = input[name];
    if (value === undefined) continue;
    if (parameter.location === "uri") {
      if (name === "Bucket") bucket = value;
      if (name === "Key") key = value;
    } else if (parameter.location === "urlPath") {
      query[parameter.sentAs ?? name] = primitiveQueryValue(value, name);
    } else if (parameter.location === "header") {
      headers[obsHeaderName(name, parameter)] = primitiveQueryValue(value, name);
    }
  }
  const contentBase64 = input.contentBase64 ?? input.Body;
  if (contentBase64 !== undefined && typeof contentBase64 !== "string") throw new Error("contentBase64 or Body must be a base64 string.");
  return callObsOpenApi({ method: entry.method, ...(typeof bucket === "string" ? { bucket } : {}), ...(typeof key === "string" ? { key } : {}), ...(Object.keys(query).length ? { query } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...(typeof contentBase64 === "string" ? { contentBase64 } : {}), ...(typeof input.region === "string" ? { region: input.region } : {}) });
}

export function generatedEcsOperations(): SubMcpOperation[] {
  return ecsCatalog.map((entry) => ({
    id: entry.id,
    description: entry.description,
    isReadOnly: isReadOnly(entry.method),
    inputSchema: generatedSchema(entry.inputNames, entry.required),
    sourceUrl: sourceUrl("ECS", entry.apiName),
    execute: (input) => callGeneratedEcs(entry, input),
  }));
}

export function generatedObsOperations(): SubMcpOperation[] {
  return obsCatalog.map((entry) => {
    const parameterNames = Object.keys(entry.parameters);
    const required = parameterNames.filter((name) => entry.parameters[name].required);
    return {
      id: entry.id,
      description: entry.description,
      isReadOnly: isReadOnly(entry.method),
      inputSchema: generatedSchema([...parameterNames, "bucket", "key", "contentBase64"], required),
      sourceUrl: sourceUrl("OBS", entry.apiName),
      execute: (input: JsonObject) => callGeneratedObs(entry, input),
    };
  });
}

export const generatedCatalogCounts = { ecs: ecsCatalog.length, obs: obsCatalog.length };
export const generatedCatalogManifest = catalogManifestJson;
