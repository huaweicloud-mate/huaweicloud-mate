import type { HostCommandRunner } from "../hosts/command-runner.js";
import {
  selectCurrentKooCliArtifact,
  type KooCliArtifactBinding,
} from "./artifacts.js";
import { discoverKooCli, type KooCliDiscoveryReport } from "./discovery.js";
import {
  inspectPrivateKooCli,
  installPrivateKooCli,
  type KooCliArtifactFetcher,
} from "./installer.js";

export type KooCliSelectionReport =
  | {
      readonly status: "compatible";
      readonly compatible: true;
      readonly source: "system" | "private";
      readonly executablePath: string;
      readonly version: string;
    }
  | {
      readonly status: "binding-missing" | "private-missing";
      readonly compatible: false;
      readonly system: KooCliDiscoveryReport;
    };

function systemSelection(
  report: KooCliDiscoveryReport,
): KooCliSelectionReport | undefined {
  return report.status === "compatible"
    ? {
        status: "compatible",
        compatible: true,
        source: "system",
        executablePath: report.executablePath,
        version: report.version,
      }
    : undefined;
}

export async function inspectKooCliAvailability(
  runtimeRoot: string,
  runner: HostCommandRunner,
  artifacts: readonly KooCliArtifactBinding[],
): Promise<KooCliSelectionReport> {
  const system = await discoverKooCli(runner);
  const selectedSystem = systemSelection(system);
  if (selectedSystem !== undefined) return selectedSystem;
  const artifact = selectCurrentKooCliArtifact(artifacts);
  if (artifact === undefined) {
    return { status: "binding-missing", compatible: false, system };
  }
  const installed = await inspectPrivateKooCli(runtimeRoot, artifact, runner);
  if (installed === undefined) {
    return { status: "private-missing", compatible: false, system };
  }
  return {
    status: "compatible",
    compatible: true,
    source: "private",
    executablePath: installed.executablePath,
    version: installed.version,
  };
}

export async function ensureKooCliAvailable(
  runtimeRoot: string,
  runner: HostCommandRunner,
  artifacts: readonly KooCliArtifactBinding[],
  fetcher?: KooCliArtifactFetcher,
): Promise<KooCliSelectionReport> {
  const system = await discoverKooCli(runner);
  const selectedSystem = systemSelection(system);
  if (selectedSystem !== undefined) return selectedSystem;
  const artifact = selectCurrentKooCliArtifact(artifacts);
  if (artifact === undefined) {
    return { status: "binding-missing", compatible: false, system };
  }
  const installed = await installPrivateKooCli({
    runtimeRoot,
    artifact,
    runner,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
  return {
    status: "compatible",
    compatible: true,
    source: "private",
    executablePath: installed.executablePath,
    version: installed.version,
  };
}
