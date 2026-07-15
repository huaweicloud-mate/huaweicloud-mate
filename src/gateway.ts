import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type JsonObject = Record<string, unknown>;

export interface ServiceOperation {
  id: string;
  description: string;
  isReadOnly: boolean;
}

export interface ServiceDefinition {
  id: string;
  title: string;
  provider: "openapi" | "koocli";
  status: "available" | "catalog_pending";
  description: string;
  operations: ServiceOperation[];
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

const services: ServiceDefinition[] = [
  {
    id: "ecs",
    title: "Elastic Cloud Server (ECS)",
    provider: "openapi",
    status: "catalog_pending",
    description: "OpenAPI adapter slot. ECS operations are registered from the official OpenAPI catalog in a follow-up implementation.",
    operations: [],
  },
  {
    id: "obs",
    title: "Object Storage Service (OBS)",
    provider: "openapi",
    status: "catalog_pending",
    description: "OpenAPI adapter slot. OBS operations are registered from the official OpenAPI catalog in a follow-up implementation.",
    operations: [],
  },
  {
    id: "koocli",
    title: "KooCLI fallback",
    provider: "koocli",
    status: "available",
    description: "Fallback for services without a dedicated OpenAPI MCP adapter. Commands run without a shell and always require user confirmation.",
    operations: [
      { id: "version", description: "Check the local KooCLI installation.", isReadOnly: true },
      { id: "run", description: "Run a structured KooCLI command. This always requires user confirmation.", isReadOnly: false },
    ],
  },
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandPath(): string {
  if (process.env.HUAWEICLOUD_KOOCLI_PATH) return process.env.HUAWEICLOUD_KOOCLI_PATH;
  const installedPath = join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? "", "huaweicloud-mate", "koocli", "hcloud.exe");
  return existsSync(installedPath) ? installedPath : "hcloud";
}

function trim(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? value.slice(-MAX_OUTPUT_LENGTH) : value;
}

async function runKooCli(input: JsonObject): Promise<unknown> {
  const supplied = input.command;
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.some((part) => typeof part !== "string" || !part)) {
    throw new Error("KooCLI input.command must be a non-empty string array.");
  }
  const command = supplied as string[];
  if (command.some((part) => SECRET_ARGUMENTS.some((secret) => part.startsWith(secret)))) {
    throw new Error("Credentials must not be passed as KooCLI command arguments. Use a KooCLI profile or environment variables.");
  }
  const profile = typeof input.profile === "string" && input.profile ? input.profile : process.env.HUAWEICLOUD_KOOCLI_PROFILE;
  const args = profile ? [...command, `--cli-profile=${profile}`] : command;
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath(), args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = trim(stdout + chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = trim(stderr + chunk.toString()); });
    child.once("error", (error) => reject(new Error(`Unable to start KooCLI: ${error.message}`)));
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve({ command: [commandPath(), ...args], stdout, stderr });
      else reject(new Error(`KooCLI exited with code ${exitCode}: ${stderr || stdout}`));
    });
  });
}

function findService(serviceId: string): ServiceDefinition {
  const service = services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new Error(`Unknown Huawei Cloud service: ${serviceId}`);
  return service;
}

function clearExpiredConfirmations(): void {
  const now = Date.now();
  for (const [token, pending] of confirmationTokens) if (pending.expiresAt <= now) confirmationTokens.delete(token);
}

function confirmationRequired(service: string, operation: string, input: JsonObject): unknown {
  clearExpiredConfirmations();
  const confirmationToken = randomUUID();
  confirmationTokens.set(confirmationToken, { service, operation, input, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
  return {
    status: "confirmation_required",
    confirmationToken,
    expiresInSeconds: CONFIRMATION_TTL_MS / 1000,
    message: "Ask the user to explicitly confirm this resource operation. Then call the exact same service, operation, and input with this confirmationToken.",
  };
}

function consumeConfirmation(token: string | undefined, service: string, operation: string, input: JsonObject): boolean {
  clearExpiredConfirmations();
  if (!token) return false;
  const pending = confirmationTokens.get(token);
  confirmationTokens.delete(token);
  return Boolean(pending && pending.service === service && pending.operation === operation && JSON.stringify(pending.input) === JSON.stringify(input));
}

export function discover(query?: string): ServiceDefinition[] {
  const keyword = query?.trim().toLowerCase();
  return services.filter((service) => !keyword || `${service.id} ${service.title} ${service.description}`.toLowerCase().includes(keyword));
}

export function provision(serviceId: string): unknown {
  const service = findService(serviceId);
  if (service.status !== "available") {
    return { service: service.id, status: service.status, message: "The OpenAPI operation catalog has not been added yet. This initialization deliberately does not claim API coverage that is not implemented." };
  }
  return { service: service.id, status: "provisioned", operations: service.operations };
}

export async function call(serviceId: string, operationId: string, input: unknown, confirmationToken?: string): Promise<unknown> {
  if (!isObject(input)) throw new Error("input must be an object");
  const service = findService(serviceId);
  const operation = service.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error(`Unknown operation ${operationId} for ${serviceId}`);
  if (!operation.isReadOnly && !consumeConfirmation(confirmationToken, serviceId, operationId, input)) {
    return confirmationRequired(serviceId, operationId, input);
  }
  if (serviceId === "koocli" && operationId === "version") return runKooCli({ command: ["version"] });
  if (serviceId === "koocli" && operationId === "run") return runKooCli(input);
  throw new Error(`No runtime adapter is registered for ${serviceId}/${operationId}`);
}
