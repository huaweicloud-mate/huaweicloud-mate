import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createExpectedApprovalBinding } from "../../src/approval/binding.js";
import { TrustedApprovalCompanion } from "../../src/approval/companion.js";
import { ApprovalError } from "../../src/approval/errors.js";
import {
  createApprovalSessionReadyMessage,
  parseApprovalSessionReadyMessage,
} from "../../src/approval/session-protocol.js";
import type {
  ApprovalReceipt,
  ApprovalSigningContext,
  ApprovalTerminal,
} from "../../src/approval/types.js";
import { TrustedApprovalVerifier } from "../../src/approval/verifier.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const now = new Date("2026-07-13T14:00:00.000Z");
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const context: ApprovalSigningContext = {
  request: {
    schemaVersion: "huaweicloud-agent-approval-request/v1",
    status: "confirmation_required",
    previewId: "preview_abcdefghijklmnopqrstuvwxyz0123456789",
    challenge: "challenge_abcdefghijklmnopqrstuvwxyz0123456789",
    parameterDigest: digest("a"),
    summary: {
      capabilityId: "huaweicloud.ecs.server.create.v1",
      executor: "provider-mcp",
      operationKind: "write",
      riskTags: ["cost", "privileged"],
      scope: {
        region: "cn-north-4",
        project: "project-1",
      },
      resources: ["ecs/server/demo"],
      effects: ["Create one billable ECS server"],
    },
    allowedIssuerIds: ["huaweicloud-mate.local-approval"],
    expiresAt: "2026-07-13T14:10:00.000Z",
  },
  credentialGeneration: "9d9b8dd6-4698-4a1a-b3ae-3cc52d7c41e4",
  accountIdentity: {
    accountId: "account-1",
    domainId: "domain-1",
  },
};

class FakeTerminal implements ApprovalTerminal {
  readonly messages: string[] = [];

  constructor(
    readonly interactive: boolean,
    private readonly answer: string,
  ) {}

  write(message: string): void {
    this.messages.push(message);
  }

  async readLine(prompt: string): Promise<string> {
    this.messages.push(prompt);
    return this.answer;
  }
}

async function createCompanion(): Promise<TrustedApprovalCompanion> {
  return TrustedApprovalCompanion.create(contractDirectory, now);
}

async function createSignedReceipt(): Promise<{
  readonly companion: TrustedApprovalCompanion;
  readonly receipt: ApprovalReceipt;
  readonly terminal: FakeTerminal;
}> {
  const companion = await createCompanion();
  const terminal = new FakeTerminal(true, "APPROVE");
  const receipt = await companion.reviewAndSign(context, terminal, { now });
  if (receipt === null) {
    throw new Error("Expected the test approval to be signed");
  }
  return { companion, receipt, terminal };
}

function expectedBinding(companion: TrustedApprovalCompanion) {
  return createExpectedApprovalBinding(context, companion.binding.sessionId);
}

function captureApprovalError(action: () => void): ApprovalError {
  try {
    action();
  } catch (error) {
    if (error instanceof ApprovalError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected an ApprovalError");
}

describe("trusted approval companion", () => {
  it("creates a distinct in-memory key and strict ready message per approval process", async () => {
    const first = await createCompanion();
    const second = await createCompanion();
    const ready = createApprovalSessionReadyMessage(first.binding);

    expect(second.binding.sessionId).not.toBe(first.binding.sessionId);
    expect(second.binding.publicKeySpki).not.toBe(first.binding.publicKeySpki);
    expect(first.binding).not.toHaveProperty("privateKey");
    expect(parseApprovalSessionReadyMessage(ready)).toEqual(ready);
    expect(() =>
      parseApprovalSessionReadyMessage({ ...ready, unexpected: true }),
    ).toThrowError(ApprovalError);
  });

  it("shows the normalized summary, signs once, and rejects replay", async () => {
    const { companion, receipt, terminal } = await createSignedReceipt();
    const verifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const expected = expectedBinding(companion);

    expect(terminal.messages.join("\n")).toContain('Account: "account-1"');
    expect(terminal.messages.join("\n")).toContain('"Create one billable ECS server"');
    expect(receipt.approvalSessionId).toBe(companion.binding.sessionId);
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(() => verifier.verifyAndConsume(receipt, expected, now)).not.toThrow();

    expect(
      captureApprovalError(() =>
        verifier.verifyAndConsume(receipt, expected, now),
      ).code,
    ).toBe("APPROVAL_REPLAYED");
    await expect(
      companion.reviewAndSign(context, new FakeTerminal(true, "APPROVE"), {
        now,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_COMPANION_USED" });
  });

  it("does not sign without an interactive exact approval", async () => {
    await expect(
      (await createCompanion()).reviewAndSign(
        context,
        new FakeTerminal(false, "APPROVE"),
        { now },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_INTERACTIVE_REQUIRED" });

    const rejected = await createCompanion();
    await expect(
      rejected.reviewAndSign(context, new FakeTerminal(true, "approve"), {
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      rejected.reviewAndSign(context, new FakeTerminal(true, "APPROVE"), {
        now,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_COMPANION_USED" });
  });

  it("escapes terminal control and bidirectional text in the approval UI", async () => {
    const companion = await createCompanion();
    const terminal = new FakeTerminal(true, "reject");
    const spoofedContext: ApprovalSigningContext = {
      ...context,
      request: {
        ...context.request,
        summary: {
          ...context.request.summary,
          effects: ["Clear screen \u001b[2J\u202eapproved"],
        },
      },
    };

    await expect(
      companion.reviewAndSign(spoofedContext, terminal, { now }),
    ).resolves.toBeNull();
    const rendered = terminal.messages.join("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u001b[2J\\u202eapproved");
  });

  it("rejects changed fields, signatures, and session public keys", async () => {
    const { companion, receipt } = await createSignedReceipt();
    const expected = expectedBinding(companion);

    const changedVerifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const changedReceipt: ApprovalReceipt = {
      ...receipt,
      parameterDigest: digest("9"),
    };
    expect(
      captureApprovalError(() =>
        changedVerifier.verifyAndConsume(changedReceipt, expected, now),
      ).code,
    ).toBe("APPROVAL_INVALID");

    const signatureVerifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const tamperedSignature: ApprovalReceipt = {
      ...receipt,
      signature: `${receipt.signature.startsWith("A") ? "B" : "A"}${receipt.signature.slice(1)}`,
    };
    expect(
      captureApprovalError(() =>
        signatureVerifier.verifyAndConsume(tamperedSignature, expected, now),
      ).code,
    ).toBe("APPROVAL_INVALID");

    const otherCompanion = await createCompanion();
    const wrongKeyForSession = {
      ...otherCompanion.binding,
      sessionId: companion.binding.sessionId,
    };
    const wrongKeyVerifier = await TrustedApprovalVerifier.create(
      wrongKeyForSession,
      contractDirectory,
    );
    expect(
      captureApprovalError(() =>
        wrongKeyVerifier.verifyAndConsume(receipt, expected, now),
      ).code,
    ).toBe("APPROVAL_INVALID");
  });

  it("rejects receipts outside the five-minute lifetime and clock skew", async () => {
    const { companion, receipt } = await createSignedReceipt();
    const verifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const afterExpiryAndSkew = new Date(now.getTime() + 330_001);

    expect(
      captureApprovalError(() =>
        verifier.verifyAndConsume(
          receipt,
          expectedBinding(companion),
          afterExpiryAndSkew,
        ),
      ).code,
    ).toBe("APPROVAL_EXPIRED");
  });
});
