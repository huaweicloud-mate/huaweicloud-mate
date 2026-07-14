#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runApprovalDoctor } from "./doctor/approval-doctor.js";
import { runContractDoctor } from "./doctor/contract-doctor.js";

const version = "0.0.0-development";

function printUsage(): void {
  console.log(`huaweicloud-mate ${version}

Usage:
  huaweicloud-mate doctor [--contracts-only | --approval-probe] [--json]
  huaweicloud-mate version

This development build does not accept credentials or execute cloud operations.`);
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const allowedArguments = new Set([
    "--contracts-only",
    "--approval-probe",
    "--json",
  ]);
  const unknownArgument = args.find((argument) => !allowedArguments.has(argument));
  if (unknownArgument !== undefined) {
    console.error(`Unknown doctor option: ${unknownArgument}`);
    return 2;
  }
  if (
    args.includes("--contracts-only") &&
    args.includes("--approval-probe")
  ) {
    console.error("--contracts-only and --approval-probe cannot be used together");
    return 2;
  }

  const contractReport = await runContractDoctor();
  const approvalProbe = args.includes("--approval-probe")
    ? await runApprovalDoctor()
    : undefined;
  const ok = contractReport.ok && (approvalProbe?.ok ?? true);
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        approvalProbe === undefined
          ? contractReport
          : { ...contractReport, approvalProbe },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Contract doctor: ${contractReport.ok ? "PASS" : "FAIL"} (${contractReport.schemaCount} schemas, ${contractReport.vectorCount} schema vectors, ${contractReport.deferredStateMachineVectorCount} runtime vectors deferred)`,
    );
    for (const vector of contractReport.vectors) {
      console.log(
        `- ${vector.passed ? "PASS" : "FAIL"} ${vector.id}: expectation=${vector.expectation}, schemaValid=${String(vector.schemaValid)}`,
      );
    }
    if (approvalProbe !== undefined) {
      console.log(
        `Approval companion probe: ${approvalProbe.ok ? "PASS" : "FAIL"} (${approvalProbe.status}, no cloud operation)`,
      );
      console.log(`- ${approvalProbe.message}`);
      if (approvalProbe.errorCode !== undefined) {
        console.log(`- errorCode=${approvalProbe.errorCode}`);
      }
    }
  }
  return ok ? 0 : 1;
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
