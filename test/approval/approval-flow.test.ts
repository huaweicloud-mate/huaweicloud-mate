import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createExpectedApprovalBinding } from "../../src/approval/binding.js";
import { TrustedApprovalCompanion } from "../../src/approval/companion.js";
import { ApprovalError } from "../../src/approval/errors.js";
import {
  ApprovalKeyStore,
  approvalKeyFileNames,
} from "../../src/approval/key-store.js";
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

const temporaryDirectories: string[] = [];

async function temporaryKeyDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "huaweicloud-mate-approval-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSignedReceipt(): Promise<{
  readonly companion: TrustedApprovalCompanion;
  readonly receipt: ApprovalReceipt;
  readonly terminal: FakeTerminal;
}> {
  const companion = await TrustedApprovalCompanion.create(
    await temporaryKeyDirectory(),
    contractDirectory,
    now,
  );
  const terminal = new FakeTerminal(true, "APPROVE");
  const receipt = await companion.reviewAndSign(context, terminal, { now });
  if (receipt === null) {
    throw new Error("Expected the test approval to be signed");
  }
  return { companion, receipt, terminal };
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("trusted approval companion", () => {
  it("creates one installation key pair and reuses the same public binding", async () => {
    const directory = await temporaryKeyDirectory();
    const first = await ApprovalKeyStore.initialize(directory, now);
    const second = await ApprovalKeyStore.initialize(
      directory,
      new Date("2026-07-14T14:00:00.000Z"),
    );

    expect(second.binding).toEqual(first.binding);
    expect(first.binding).not.toHaveProperty("privateKey");
    expect(
      await readFile(join(directory, approvalKeyFileNames.publicBinding), "utf8"),
    ).not.toContain("PRIVATE KEY");

    if (process.platform !== "win32") {
      const privateFile = await stat(
        join(directory, approvalKeyFileNames.privateKey),
      );
      expect(privateFile.mode & 0o077).toBe(0);
    }
  });

  it("fails closed when the persisted public binding no longer matches the private key", async () => {
    const directory = await temporaryKeyDirectory();
    const keyStore = await ApprovalKeyStore.initialize(directory, now);
    const bindingPath = join(directory, approvalKeyFileNames.publicBinding);
    const changedBinding = {
      ...keyStore.binding,
      publicKeySpki: `${keyStore.binding.publicKeySpki.startsWith("A") ? "B" : "A"}${keyStore.binding.publicKeySpki.slice(1)}`,
    };
    await writeFile(bindingPath, `${JSON.stringify(changedBinding, null, 2)}\n`);

    await expect(
      ApprovalKeyStore.initialize(directory, now),
    ).rejects.toMatchObject({ code: "APPROVAL_KEY_INVALID" });
  });

  it("shows the normalized summary, signs once, and rejects replay", async () => {
    const { companion, receipt, terminal } = await createSignedReceipt();
    const verifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const expected = createExpectedApprovalBinding(context);

    expect(terminal.messages.join("\n")).toContain('Account: "account-1"');
    expect(terminal.messages.join("\n")).toContain('"Create one billable ECS server"');
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(() => verifier.verifyAndConsume(receipt, expected, now)).not.toThrow();

    const replay = captureApprovalError(() =>
      verifier.verifyAndConsume(receipt, expected, now),
    );
    expect(replay.code).toBe("APPROVAL_REPLAYED");
  });

  it("does not sign without an interactive exact approval", async () => {
    const companion = await TrustedApprovalCompanion.create(
      await temporaryKeyDirectory(),
      contractDirectory,
      now,
    );

    await expect(
      companion.reviewAndSign(context, new FakeTerminal(false, "APPROVE"), {
        now,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_INTERACTIVE_REQUIRED" });
    await expect(
      companion.reviewAndSign(context, new FakeTerminal(true, "approve"), {
        now,
      }),
    ).resolves.toBeNull();
  });

  it("escapes terminal control and bidirectional text in the approval UI", async () => {
    const companion = await TrustedApprovalCompanion.create(
      await temporaryKeyDirectory(),
      contractDirectory,
      now,
    );
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

  it("rejects changed bindings and tampered signatures", async () => {
    const { companion, receipt } = await createSignedReceipt();
    const expected = createExpectedApprovalBinding(context);

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
  });

  it("rejects receipts outside the five-minute lifetime and clock skew", async () => {
    const { companion, receipt } = await createSignedReceipt();
    const verifier = await TrustedApprovalVerifier.create(
      companion.binding,
      contractDirectory,
    );
    const afterExpiryAndSkew = new Date(now.getTime() + 330_001);

    const expired = captureApprovalError(() =>
      verifier.verifyAndConsume(
        receipt,
        createExpectedApprovalBinding(context),
        afterExpiryAndSkew,
      ),
    );
    expect(expired.code).toBe("APPROVAL_EXPIRED");
  });
});
