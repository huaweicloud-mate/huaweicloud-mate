import * as z from "zod/v4";

const riskTagSchema = z.enum([
  "destructive",
  "privileged",
  "cost",
  "sensitive-read",
]);
const executorSchema = z.enum(["provider-mcp", "koocli"]);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u);

const scopeSchema = z
  .object({
    region: z.string().min(1).max(128).optional(),
    project: z.string().min(1).max(256).optional(),
  })
  .strict();

const approvalReceiptSchema = z
  .object({
    schemaVersion: z.literal("huaweicloud-agent-approval-receipt/v1"),
    issuerId: z.string().regex(/^[a-z0-9.-]+$/u),
    approvalSessionId: opaqueIdSchema,
    previewId: opaqueIdSchema,
    challengeDigest: digestSchema,
    parameterDigest: digestSchema,
    executor: executorSchema,
    credentialGeneration: z.uuid(),
    accountIdentityDigest: digestSchema,
    scopeDigest: digestSchema,
    approvedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    signatureAlgorithm: z.literal("ed25519"),
    signature: opaqueIdSchema,
  })
  .strict();

export const capabilitySearchInputSchema = z
  .object({
    schemaVersion: z.literal("huaweicloud-agent-search-input/v1-lite"),
    query: z.string().min(1).max(1000),
    product: z.string().regex(/^[a-z0-9-]+$/u).optional(),
    operationKind: z.enum(["read", "write"]).optional(),
    riskTags: z.array(riskTagSchema).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const capabilityDescribeInputSchema = z
  .object({
    schemaVersion: z.literal("huaweicloud-agent-describe-input/v1-lite"),
    capabilityId: z.string().min(1).max(160),
  })
  .strict();

export const actionExecuteInputSchema = z
  .object({
    schemaVersion: z.literal("huaweicloud-agent-execute-input/v1-lite"),
    capabilityId: z.string().min(1).max(160),
    arguments: z.record(z.string(), z.unknown()),
    scope: scopeSchema,
    executorPreference: executorSchema.optional(),
    previewId: opaqueIdSchema.optional(),
    approvalReceipt: approvalReceiptSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.previewId === undefined) ===
      (value.approvalReceipt === undefined),
    {
      message: "previewId and approvalReceipt must be supplied together",
    },
  );
