import type { ObsEnv } from "../config/env.js";
import type { OperationSpec } from "../operations/types.js";

export interface GateResult {
  allowed: true;
}

export function enforceOperationGate(spec: OperationSpec, args: Record<string, unknown>, env: ObsEnv): GateResult {
  if ((spec.risk === "write" || spec.risk === "destructive") && !env.enableWrite) {
    throw new Error(`${spec.toolName} is a write operation. Set HUAWEICLOUD_OBS_ENABLE_WRITE=true to enable it.`);
  }

  if ((spec.risk === "delete" || spec.risk === "destructive") && !env.enableDelete) {
    throw new Error(`${spec.toolName} is a delete/destructive operation. Set HUAWEICLOUD_OBS_ENABLE_DELETE=true to enable it.`);
  }

  if (spec.risk === "config_write" && !env.enableConfigWrite) {
    throw new Error(`${spec.toolName} changes bucket/object configuration. Set HUAWEICLOUD_OBS_ENABLE_CONFIG_WRITE=true to enable it.`);
  }

  if (spec.requiresConfirm) {
    const expected = confirmationTarget(spec, args);
    const actual = String(args.confirm ?? "");
    if (!expected || actual !== expected) {
      throw new Error(`${spec.toolName} requires confirm="${expected}" to run.`);
    }
  }

  return { allowed: true };
}

function confirmationTarget(spec: OperationSpec, args: Record<string, unknown>): string | undefined {
  if (spec.requiresConfirm === "bucket") {
    return stringArg(args, "bucket");
  }
  if (spec.requiresConfirm === "object") {
    const bucket = stringArg(args, "bucket");
    const key = stringArg(args, "key");
    return bucket && key ? `${bucket}/${key}` : undefined;
  }
  const bucket = stringArg(args, "bucket");
  const key = stringArg(args, "key");
  return key && bucket ? `${bucket}/${key}` : bucket;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
