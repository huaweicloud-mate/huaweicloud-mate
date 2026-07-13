import { approvalReceiptSigningPayload } from "./canonical.js";
import {
  approvalIssuerId,
  approvalSignatureAlgorithm,
  maxApprovalReceiptTtlMs,
} from "./constants.js";
import { createExpectedApprovalBinding } from "./binding.js";
import { ApprovalError } from "./errors.js";
import { ApprovalKeyStore } from "./key-store.js";
import type {
  ApprovalPublicKeyBinding,
  ApprovalReceipt,
  ApprovalSigningContext,
  ApprovalTerminal,
  UnsignedApprovalReceipt,
} from "./types.js";
import { ContractRegistry } from "../contracts/registry.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function terminalText(value: string): string {
  return JSON.stringify(value).replace(
    /[\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function renderSummary(context: ApprovalSigningContext): string {
  const { request, accountIdentity } = context;
  const risk = request.summary.riskTags.length === 0
    ? "none"
    : request.summary.riskTags.join(", ");
  const scope = [
    request.summary.scope.region === undefined
      ? undefined
      : `region=${terminalText(request.summary.scope.region)}`,
    request.summary.scope.project === undefined
      ? undefined
      : `project=${terminalText(request.summary.scope.project)}`,
  ].filter((value): value is string => value !== undefined).join(", ") || "global";
  const resources = request.summary.resources.length === 0
    ? "  - (none declared)"
    : request.summary.resources
      .map((resource) => `  - ${terminalText(resource)}`)
      .join("\n");
  const effects = request.summary.effects
    .map((effect) => `  - ${terminalText(effect)}`)
    .join("\n");

  return `\nHuawei Cloud operation approval\n\nCapability: ${terminalText(request.summary.capabilityId)}\nExecutor: ${request.summary.executor}\nOperation: ${request.summary.operationKind}\nRisk: ${risk}\nAccount: ${terminalText(accountIdentity.accountId)}${accountIdentity.domainId === undefined ? "" : ` (domain ${terminalText(accountIdentity.domainId)})`}\nScope: ${scope}\nParameter digest: ${request.parameterDigest}\nResources:\n${resources}\nEffects:\n${effects}\nRequest expires: ${request.expiresAt}\n\n`;
}

function validateSigningContext(context: ApprovalSigningContext): void {
  if (!uuidPattern.test(context.credentialGeneration)) {
    throw new ApprovalError(
      "APPROVAL_REQUEST_INVALID",
      "Credential generation is not a valid UUID",
    );
  }
  if (
    context.accountIdentity.accountId.length === 0 ||
    context.accountIdentity.accountId.length > 256 ||
    (context.accountIdentity.domainId !== undefined &&
      (context.accountIdentity.domainId.length === 0 ||
        context.accountIdentity.domainId.length > 256))
  ) {
    throw new ApprovalError(
      "APPROVAL_REQUEST_INVALID",
      "Approval account identity is invalid",
    );
  }
}

export class TrustedApprovalCompanion {
  readonly binding: ApprovalPublicKeyBinding;

  private constructor(
    private readonly keyStore: ApprovalKeyStore,
    private readonly contracts: ContractRegistry,
  ) {
    this.binding = keyStore.binding;
  }

  static async create(
    keyDirectory: string,
    contractDirectory?: URL,
    now = new Date(),
  ): Promise<TrustedApprovalCompanion> {
    const [keyStore, contracts] = await Promise.all([
      ApprovalKeyStore.initialize(keyDirectory, now),
      ContractRegistry.load(contractDirectory),
    ]);
    return new TrustedApprovalCompanion(keyStore, contracts);
  }

  async reviewAndSign(
    context: ApprovalSigningContext,
    terminal: ApprovalTerminal,
    options: { readonly now?: Date; readonly ttlSeconds?: number } = {},
  ): Promise<ApprovalReceipt | null> {
    if (!terminal.interactive) {
      throw new ApprovalError(
        "APPROVAL_INTERACTIVE_REQUIRED",
        "Trusted approval requires an interactive terminal",
      );
    }

    const requestValidation = this.contracts.validate(
      "approval-v1.schema.json",
      context.request,
    );
    if (!requestValidation.valid) {
      throw new ApprovalError(
        "APPROVAL_REQUEST_INVALID",
        "Approval request does not match the frozen contract",
      );
    }
    validateSigningContext(context);
    if (
      context.request.allowedIssuerIds.length !== 1 ||
      context.request.allowedIssuerIds[0] !== approvalIssuerId
    ) {
      throw new ApprovalError(
        "APPROVAL_REQUEST_INVALID",
        "Approval request does not allow the installed issuer",
      );
    }

    const now = options.now ?? new Date();
    const requestExpiresAt = Date.parse(context.request.expiresAt);
    if (!Number.isFinite(requestExpiresAt) || requestExpiresAt <= now.getTime()) {
      throw new ApprovalError(
        "APPROVAL_REQUEST_EXPIRED",
        "Approval request has expired",
      );
    }

    const ttlSeconds = options.ttlSeconds ?? 300;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
      throw new ApprovalError(
        "APPROVAL_REQUEST_INVALID",
        "Approval receipt TTL must be between 1 and 300 seconds",
      );
    }

    terminal.write(renderSummary(context));
    const answer = await terminal.readLine('Type "APPROVE" to authorize once: ');
    if (answer !== "APPROVE") {
      return null;
    }

    const expected = createExpectedApprovalBinding(context);
    const expiresAt = new Date(
      Math.min(
        now.getTime() + Math.min(ttlSeconds * 1000, maxApprovalReceiptTtlMs),
        requestExpiresAt,
      ),
    );
    const unsigned: UnsignedApprovalReceipt = {
      schemaVersion: "huaweicloud-agent-approval-receipt/v1",
      issuerId: expected.issuerId,
      previewId: expected.previewId,
      challengeDigest: expected.challengeDigest,
      parameterDigest: expected.parameterDigest,
      executor: expected.executor,
      credentialGeneration: expected.credentialGeneration,
      accountIdentityDigest: expected.accountIdentityDigest,
      scopeDigest: expected.scopeDigest,
      approvedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      signatureAlgorithm: approvalSignatureAlgorithm,
    };
    const receipt: ApprovalReceipt = {
      ...unsigned,
      signature: this.keyStore.sign(approvalReceiptSigningPayload(unsigned)),
    };

    if (!this.contracts.validate("approval-v1.schema.json", receipt).valid) {
      throw new ApprovalError(
        "APPROVAL_INVALID",
        "Generated approval receipt failed contract validation",
      );
    }
    return receipt;
  }
}
