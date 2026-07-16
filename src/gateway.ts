import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./openapi";
import { findSubMcpDescriptor, loadSubMcp, subMcpDescriptors } from "./submcp";
import type { SubMcp, SubMcpOperation } from "./submcp/types";

export interface ServiceOperation {
  id: string;
  description: string;
  isReadOnly: boolean;
}

export interface ServiceDefinition {
  id: string;
  title: string;
  provider: "openapi-child-mcp";
  status: "available";
  description: string;
  sourceUrl: string;
}

interface PendingConfirmation {
  service: string;
  operation: string;
  input: JsonObject;
  expiresAt: number;
}

const confirmationTokens = new Map<string, PendingConfirmation>();
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 20_000;
const SECRET_ARGUMENTS = ["--cli-access-key", "--cli-secret-key", "--cli-security-token"];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateValue(value: unknown, schema: JsonObject, path: string): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) throw new Error(`${path} must be one of: ${schema.enum.map(String).join(", ")}.`);
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} must be a string.`);
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a finite number.`);
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`${path} must be an integer.`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  if (schema.type === "object") {
    if (!isObject(value)) throw new Error(`${path} must be an object.`);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) if (typeof name === "string" && value[name] === undefined) throw new Error(`${path}.${name} is required.`);
    if (isObject(schema.properties)) {
      for (const [name, propertySchema] of Object.entries(schema.properties)) {
        if (value[name] !== undefined && isObject(propertySchema)) validateValue(value[name], propertySchema, `${path}.${name}`);
      }
    }
  }
  if (schema.format === "base64" && (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) throw new Error(`${path} must be a valid base64 string.`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} must contain at least ${schema.minItems} item(s).`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} must contain at most ${schema.maxItems} item(s).`);
    const itemSchema = schema.items;
    if (isObject(itemSchema)) value.forEach((item, index) => validateValue(item, itemSchema, `${path}[${index}]`));
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}.`);
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}.`);
}

function validateInput(input: JsonObject, schema: JsonObject): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) if (typeof name === "string" && input[name] === undefined) throw new Error(`${name} is required.`);
  if (!isObject(schema.properties)) return;
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (input[name] !== undefined && isObject(propertySchema)) validateValue(input[name], propertySchema, name);
  }
}

function commandPath(): string {
  if (process.env.HUAWEICLOUD_KOOCLI_PATH) return process.env.HUAWEICLOUD_KOOCLI_PATH;
  const installedPath = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? "", "huaweicloud-mate", "koocli", "hcloud.exe")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "huaweicloud-mate", "koocli", "hcloud");
  return existsSync(installedPath) ? installedPath : "hcloud";
}

function trim(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? value.slice(-MAX_OUTPUT_LENGTH) : value;
}

async function runKooCli(input: JsonObject): Promise<unknown> {
  const supplied = input.command;
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.some((part) => typeof part !== "string" || !part)) throw new Error("KooCLI input.command must be a non-empty string array.");
  const command = supplied as string[];
  if (command.some((part) => SECRET_ARGUMENTS.some((secret) => part.startsWith(secret)))) throw new Error("Credentials must not be passed as KooCLI command arguments. Use a KooCLI profile or environment variables.");
  const profile = typeof input.profile === "string" && input.profile ? input.profile : process.env.HUAWEICLOUD_KOOCLI_PROFILE;
  const args = profile ? [...command, `--cli-profile=${profile}`] : command;
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath(), args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = trim(stdout + chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = trim(stderr + chunk.toString()); });
    child.once("error", (error) => reject(new Error(`Unable to start KooCLI: ${error.message}`)));
    child.once("close", (exitCode) => exitCode === 0 ? resolve({ command: [commandPath(), ...args], stdout, stderr }) : reject(new Error(`KooCLI exited with code ${exitCode}: ${stderr || stdout}`)));
  });
}

function findOperation(service: SubMcp, operationId: string): SubMcpOperation {
  const operation = service.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`Unknown operation ${operationId} for ${service.id} child MCP`);
  return operation;
}

function clearExpiredConfirmations(): void {
  const now = Date.now();
  for (const [token, pending] of confirmationTokens) if (pending.expiresAt <= now) confirmationTokens.delete(token);
}

function confirmationRequired(service: string, operation: string, input: JsonObject): unknown {
  clearExpiredConfirmations();
  const confirmationToken = randomUUID();
  confirmationTokens.set(confirmationToken, { service, operation, input, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
  return { status: "confirmation_required", confirmationToken, expiresInSeconds: CONFIRMATION_TTL_MS / 1000, message: "Ask the user to explicitly confirm this resource operation. Then call the exact same service, operation, and input with this confirmationToken." };
}

function consumeConfirmation(token: string | undefined, service: string, operation: string, input: JsonObject): boolean {
  clearExpiredConfirmations();
  if (!token) return false;
  const pending = confirmationTokens.get(token);
  confirmationTokens.delete(token);
  return Boolean(pending && pending.service === service && pending.operation === operation && stableJson(pending.input) === stableJson(input));
}

export function discover(query?: string): ServiceDefinition[] {
  const keyword = query?.trim().toLowerCase();
  return subMcpDescriptors
    .filter((service) => !keyword || `${service.id} ${service.title} ${service.description}`.toLowerCase().includes(keyword))
    .map((service) => ({ ...service, provider: "openapi-child-mcp" as const, status: "available" as const }));
}

export async function provision(serviceId: string): Promise<unknown> {
  const descriptor = findSubMcpDescriptor(serviceId);
  const service = await loadSubMcp(descriptor.id);
  return { subMcp: service.id, status: "provisioned", sourceUrl: service.sourceUrl, operations: service.operations.map(({ id, description, isReadOnly, inputSchema, sourceUrl }) => ({ id, description, isReadOnly, inputSchema, sourceUrl })) };
}

export async function call(serviceId: string, operationId: string, input: unknown, confirmationToken?: string): Promise<unknown> {
  if (!isObject(input)) throw new Error("input must be an object");
  if (serviceId === "koocli") {
    if (operationId === "version") return runKooCli({ command: ["version"] });
    if (operationId === "run") {
      validateInput(input, { type: "object", properties: { command: { type: "array", items: { type: "string" } }, profile: { type: "string" } }, required: ["command"] });
      if (!consumeConfirmation(confirmationToken, serviceId, operationId, input)) return confirmationRequired(serviceId, operationId, input);
      return runKooCli(input);
    }
    throw new Error(`Unknown KooCLI fallback operation: ${operationId}`);
  }
  const child = await loadSubMcp(serviceId);
  const operation = findOperation(child, operationId);
  validateInput(input, operation.inputSchema);
  const requiresConfirmation = operation.requiresConfirmation?.(input) ?? !operation.isReadOnly;
  if (requiresConfirmation && !consumeConfirmation(confirmationToken, serviceId, operationId, input)) return confirmationRequired(serviceId, operationId, input);
  return operation.execute(input);
}
