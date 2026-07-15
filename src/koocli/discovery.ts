import type { HostCommandRunner } from "../hosts/command-runner.js";

export const minimumKooCliVersion = "7.2.2";
export const maximumKooCliMajor = 8;

export type KooCliDiscoveryReport =
  | { readonly status: "unavailable"; readonly compatible: false }
  | {
      readonly status: "unhealthy";
      readonly compatible: false;
      readonly executablePath: string;
    }
  | {
      readonly status: "incompatible" | "compatible";
      readonly compatible: boolean;
      readonly executablePath: string;
      readonly version: string;
    };

function parseVersion(value: string): [number, number, number] | undefined {
  const matches = [...value.matchAll(
    /(?:^|[^0-9])([0-9]+)\.([0-9]+)\.([0-9]+)(?=$|[^0-9])/gu,
  )];
  const versions = new Map<string, [number, number, number]>();
  for (const match of matches) {
    const parts = match.slice(1, 4).map((part) => Number(part));
    if (
      parts.length !== 3 ||
      parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 9999)
    ) {
      continue;
    }
    const version = `${parts[0]}.${parts[1]}.${parts[2]}`;
    versions.set(version, parts as [number, number, number]);
  }
  return versions.size === 1 ? [...versions.values()][0] : undefined;
}

function compare(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export async function inspectKooCliExecutable(
  executablePath: string,
  runner: HostCommandRunner,
): Promise<KooCliDiscoveryReport> {
  const result = await runner.run(executablePath, ["version"], 10_000);
  if (result.code !== 0 || result.signal !== null) {
    return { status: "unhealthy", compatible: false, executablePath };
  }
  const parsed = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (parsed === undefined) {
    return { status: "unhealthy", compatible: false, executablePath };
  }
  const minimum = [7, 2, 2] as const;
  const compatible = compare(parsed, minimum) >= 0 && parsed[0] < maximumKooCliMajor;
  return {
    status: compatible ? "compatible" : "incompatible",
    compatible,
    executablePath,
    version: parsed.join("."),
  };
}

export async function discoverKooCli(
  runner: HostCommandRunner,
): Promise<KooCliDiscoveryReport> {
  const executablePath = await runner.resolveCommand("hcloud");
  if (executablePath === undefined) {
    return { status: "unavailable", compatible: false };
  }
  return await inspectKooCliExecutable(executablePath, runner);
}
