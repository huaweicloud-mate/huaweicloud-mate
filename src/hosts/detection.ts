import { lstat } from "node:fs/promises";

import { InstallerError } from "../installer/errors.js";
import type { HostInstallPlan } from "./plan.js";
import type { HostCommandRunner } from "./command-runner.js";
import type { HostId } from "./types.js";

export interface HostDetectionEvidence {
  readonly id: HostId;
  readonly commandDetected: boolean;
  readonly detectedPathCount: number;
  readonly installable: boolean;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

async function countDetectedPaths(paths: readonly string[]): Promise<number> {
  let count = 0;
  for (const path of paths) {
    try {
      const entry = await lstat(path);
      if ((entry.isFile() || entry.isDirectory()) && !entry.isSymbolicLink()) {
        count += 1;
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw new InstallerError(
          "HOST_DISCOVERY_FAILED",
          "Host detection path could not be inspected",
        );
      }
    }
  }
  return count;
}

async function hasDetectedCommand(
  commands: readonly string[],
  runner: HostCommandRunner,
): Promise<boolean> {
  for (const command of commands) {
    if (await runner.resolveCommand(command) !== undefined) return true;
  }
  return false;
}

export async function detectInstallableHosts(
  plans: readonly HostInstallPlan[],
  runner: HostCommandRunner,
): Promise<readonly HostDetectionEvidence[]> {
  if (
    plans.length === 0 ||
    plans.length > 4 ||
    new Set(plans.map((plan) => plan.id)).size !== plans.length
  ) {
    throw new InstallerError(
      "HOST_DISCOVERY_FAILED",
      "Host discovery plans are invalid",
    );
  }
  const detected: HostDetectionEvidence[] = [];
  for (const plan of plans) {
    const commandDetected = await hasDetectedCommand(
      plan.detectCommands,
      runner,
    );
    const detectedPathCount = await countDetectedPaths(plan.detectPaths);
    detected.push({
      id: plan.id,
      commandDetected,
      detectedPathCount,
      installable: commandDetected ||
        (plan.id === "codearts" && detectedPathCount > 0),
    });
  }
  return detected;
}
