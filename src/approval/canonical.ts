import { createHash } from "node:crypto";

import type {
  ApprovalAccountIdentity,
  ApprovalScope,
  UnsignedApprovalReceipt,
} from "./types.js";

function canonicalizeStringEntries(
  entries: readonly (readonly [string, string])[],
): string {
  return JSON.stringify(
    Object.fromEntries(
      [...entries].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

export function sha256String(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestAccountIdentity(identity: ApprovalAccountIdentity): string {
  const entries: [string, string][] = [["accountId", identity.accountId]];
  if (identity.domainId !== undefined) {
    entries.push(["domainId", identity.domainId]);
  }
  return sha256String(canonicalizeStringEntries(entries));
}

export function digestApprovalScope(scope: ApprovalScope): string {
  const entries: [string, string][] = [];
  if (scope.project !== undefined) {
    entries.push(["project", scope.project]);
  }
  if (scope.region !== undefined) {
    entries.push(["region", scope.region]);
  }
  return sha256String(canonicalizeStringEntries(entries));
}

export function approvalReceiptSigningPayload(
  receipt: UnsignedApprovalReceipt,
): Buffer {
  const entries = Object.entries(receipt).map(
    ([key, value]) => [key, value] as const,
  );
  return Buffer.from(canonicalizeStringEntries(entries), "utf8");
}
