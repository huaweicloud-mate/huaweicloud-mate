#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runContractDoctor } from "./doctor/contract-doctor.js";

const version = "0.0.0-development";

function printUsage(): void {
  console.log(`huaweicloud-mate ${version}

Usage:
  huaweicloud-mate doctor [--contracts-only] [--json]
  huaweicloud-mate version

This development build does not accept credentials or execute cloud operations.`);
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const allowedArguments = new Set(["--contracts-only", "--json"]);
  const unknownArgument = args.find((argument) => !allowedArguments.has(argument));
  if (unknownArgument !== undefined) {
    console.error(`Unknown doctor option: ${unknownArgument}`);
    return 2;
  }

  const report = await runContractDoctor();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Contract doctor: ${report.ok ? "PASS" : "FAIL"} (${report.schemaCount} schemas, ${report.vectorCount} schema vectors, ${report.deferredStateMachineVectorCount} runtime vectors deferred)`,
    );
    for (const vector of report.vectors) {
      console.log(
        `- ${vector.passed ? "PASS" : "FAIL"} ${vector.id}: expectation=${vector.expectation}, schemaValid=${String(vector.schemaValid)}`,
      );
    }
  }
  return report.ok ? 0 : 1;
}

export async function main(args: readonly string[]): Promise<number> {
  const [command, ...commandArguments] = args;
  switch (command) {
    case "doctor":
      return runDoctor(commandArguments);
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 2;
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
