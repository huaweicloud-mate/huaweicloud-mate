import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalCompanionLauncher, sha256File } from "../../src/approval/launcher.js";
import { JsonlAuditSink } from "../../src/audit/jsonl.js";
import type { RouterAuditSink } from "../../src/audit/types.js";
import type { RouterAuditEvent } from "../../src/audit/types.js";
import type { CredentialPermissionPolicy } from "../../src/auth/permissions.js";
import { developmentCapabilityRegistrations } from "../../src/catalog/development.js";
import { createDevelopmentRuntime } from "../../src/development/runtime.js";
import { developmentIdentity } from "../../src/executors/development-reference.js";
import { RouterCore } from "../../src/router/core.js";
import type { RouterExecutorAdapter } from "../../src/router/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const companionFixturePath = resolve("test/fixtures/approval-companion-child.mjs");
const roots: string[] = [];
const permissions: CredentialPermissionPolicy = {
  secureDirectory: vi.fn(async () => undefined),
  secureFile: vi.fn(async () => undefined),
  verifyFile: vi.fn(async () => undefined),
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-audit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("Router JSONL audit log", () => {
  it("rotates the bounded primary log without appending past eight MiB", async () => {
    const root = await temporaryRoot();
    const path = resolve(root, "logs", "router.jsonl");
    const auditSink = new JsonlAuditSink({ path, permissions });
    const event: RouterAuditEvent = {
      schemaVersion: "huaweicloud-mate-audit/v1",
      timestamp: "2026-07-15T00:00:00.000Z",
      agent: "codex",
      pluginVersion: "0.0.0-development",
      correlationId: "audit-rotation-test",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      product: "reference",
      executor: "provider-mcp",
      scope: {},
      riskTags: [],
      parameterDigest: `sha256:${"a".repeat(64)}`,
      event: "dispatch-started",
      approval: "not-required",
    };
    await auditSink.record(event);
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x78));

    await auditSink.record(event);

    expect((await stat(`${path}.1`)).size).toBe(8 * 1024 * 1024);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  it("records fixed metadata and digests without parameter or result bodies", async () => {
    const root = await temporaryRoot();
    const path = resolve(root, "logs", "router.jsonl");
    const auditSink = new JsonlAuditSink({ path, permissions });
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      auditSink,
      approvalReviewer: new ApprovalCompanionLauncher({
        entryPath: companionFixturePath,
        expectedSha256: await sha256File(companionFixturePath),
        contractDirectory,
        timeoutMs: 10_000,
      }),
    });
    const accessSentinel = "AK_SENTINEL_MUST_NOT_APPEAR";
    const secretSentinel = "SK_SENTINEL_MUST_NOT_APPEAR";

    await runtime.router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      arguments: { query: accessSentinel },
      scope: { region: "cn-north-4" },
    });
    const writeInput = {
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite" as const,
      capabilityId: "huaweicloud.reference.change.simulate.v1",
      arguments: { name: secretSentinel },
      scope: {},
    };
    const preview = await runtime.router.execute(writeInput);
    if (preview.status !== "confirmation_required") {
      throw new Error("Expected an approval preview");
    }
    await runtime.router.execute({ ...writeInput, previewId: preview.previewId });

    const text = await readFile(path, "utf8");
    expect(text).not.toContain(accessSentinel);
    expect(text).not.toContain(secretSentinel);
    expect(text).not.toContain("internalTrace");
    expect(text).not.toContain("credentialGeneration");
    expect(text).not.toContain("sessionId");
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual([
      "dispatch-started",
      "dispatch-completed",
      "preview-created",
      "dispatch-started",
      "dispatch-completed",
    ]);
    expect(events[0]).toMatchObject({
      schemaVersion: "huaweicloud-mate-audit/v1",
      agent: "unknown-mcp-client",
      pluginVersion: "0.0.0-development",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      product: "reference",
      executor: "provider-mcp",
      scope: { region: "cn-north-4" },
      riskTags: [],
      approval: "not-required",
    });
    expect(events[0].parameterDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(events[1].resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(events[0].correlationId).toBe(events[1].correlationId);
    expect(events[2].correlationId).toBe(events[3].correlationId);
    expect(events[3].correlationId).toBe(events[4].correlationId);
    expect(permissions.secureFile).toHaveBeenCalled();
  }, 20_000);

  it("blocks dispatch when the intent cannot be logged", async () => {
    const execute = vi.fn();
    const adapter: RouterExecutorAdapter = {
      executor: "provider-mcp",
      isAvailable: async () => true,
      execute,
    };
    const auditSink: RouterAuditSink = {
      record: vi.fn(async () => { throw new Error("disk unavailable"); }),
    };
    const router = await RouterCore.create({
      capabilities: developmentCapabilityRegistrations,
      adapters: [adapter],
      identityProvider: async () => developmentIdentity,
      approvalReviewer: { review: async () => null },
      contractDirectory,
      auditSink,
    });

    await expect(router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      arguments: {},
      scope: {},
    })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not turn a known completed dispatch into a retryable failure when final logging fails", async () => {
    const record = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk filled after dispatch"));
    const auditSink: RouterAuditSink = { record };
    const runtime = await createDevelopmentRuntime({
      contractDirectory,
      auditSink,
      approvalReviewer: { review: async () => null },
    });

    await expect(runtime.router.execute({
      schemaVersion: "huaweicloud-agent-execute-input/v1-lite",
      capabilityId: "huaweicloud.reference.catalog.inspect.v1",
      arguments: {},
      scope: {},
    })).resolves.toMatchObject({ status: "completed" });
    expect(record).toHaveBeenCalledTimes(2);
  });
});
