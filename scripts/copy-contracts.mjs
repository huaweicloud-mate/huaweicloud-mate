import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const contractFiles = [
  "approval-v1.schema.json",
  "capability-v1-lite.schema.json",
  "credential-session-v1.schema.json",
  "host-template-v1-lite.schema.json",
  "koocli-policy-v1-lite.schema.json",
  "provider-v1-lite.schema.json",
  "router-tools-v1-lite.schema.json",
  "m0-contract-vectors.json",
];

const sourceDirectory = new URL("../docs/契约/", import.meta.url);
const targetDirectory = new URL("../dist/contracts/schema/", import.meta.url);

await mkdir(fileURLToPath(targetDirectory), { recursive: true });

await Promise.all(
  contractFiles.map((fileName) =>
    copyFile(new URL(fileName, sourceDirectory), new URL(fileName, targetDirectory)),
  ),
);
