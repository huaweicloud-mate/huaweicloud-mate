import {
  digestAccountIdentity,
  digestApprovalScope,
  sha256String,
} from "./canonical.js";
import { approvalIssuerId } from "./constants.js";
import type {
  ApprovalSigningContext,
  ExpectedApprovalBinding,
} from "./types.js";

export function createExpectedApprovalBinding(
  context: ApprovalSigningContext,
): ExpectedApprovalBinding {
  return {
    issuerId: approvalIssuerId,
    previewId: context.request.previewId,
    challengeDigest: sha256String(context.request.challenge),
    parameterDigest: context.request.parameterDigest,
    executor: context.request.summary.executor,
    credentialGeneration: context.credentialGeneration,
    accountIdentityDigest: digestAccountIdentity(context.accountIdentity),
    scopeDigest: digestApprovalScope(context.request.summary.scope),
  };
}
