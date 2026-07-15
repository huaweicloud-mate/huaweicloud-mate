import { RouterError } from "./errors.js";
import { redactedValue } from "./redaction.js";

const sensitiveKeys = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "ak",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "credentialsecret",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "routetoken",
  "secretaccesskey",
  "secretkey",
  "securitytoken",
  "sessionid",
  "sessiontoken",
  "sk",
  "token",
]);

const sensitiveTextPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u,
  /\b(?:authorization|proxy-authorization|x-auth-token|x-security-token)\s*[:=]\s*\S+/iu,
  /(?:[?&]|\b)(?:accesskeyid|securitytoken|signature|x-amz-credential|x-amz-signature|x-obs-signature|x-security-token)=[^\s&#]+/iu,
  /\bSDK-HMAC-SHA256\s+Access=[^,\s]+/u,
  /\bOBS\s+[A-Z0-9]{10,}:[A-Za-z0-9+/=]{16,}/u,
  /["']?(?:accessKey|accessKeyId|secretKey|secretAccessKey|clientSecret|password|authorization|routeToken|sessionId|accessToken|refreshToken)["']?\s*[:=]\s*["']?[^,\s"']{8,}/u,
] as const;

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized === "apisecret"
  );
}

function isFullyRedacted(value: unknown): boolean {
  if (value === redactedValue) return true;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => isFullyRedacted(entry));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length > 0 && entries.every((entry) => isFullyRedacted(entry));
  }
  return false;
}

function containsSensitiveText(value: string): boolean {
  if (value === redactedValue) return false;
  return sensitiveTextPatterns.some((pattern) => pattern.test(value));
}

export function assertNoSensitiveOutput(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsSensitiveText(current)) {
        throw new RouterError(
          "OUTPUT_REJECTED",
          "Executor result contains undeclared sensitive material",
        );
      }
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveKey(key) && !isFullyRedacted(child)) {
        throw new RouterError(
          "OUTPUT_REJECTED",
          "Executor result contains undeclared sensitive material",
        );
      }
      pending.push(child);
    }
  }
}
