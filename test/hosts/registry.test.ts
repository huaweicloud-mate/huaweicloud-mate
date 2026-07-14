import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HostTemplateRegistry } from "../../src/hosts/registry.js";
import type { HostId } from "../../src/hosts/types.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);
const temporaryRoots: string[] = [];

function template(id: HostId): Record<string, unknown> {
  return {
    schemaVersion: "huaweicloud-agent-host-template/v1-lite",
    id,
    displayName: id,
    detect: { commands: [id], paths: [] },
    mcp: {
      configPath: `{userConfig}/${id}/mcp.json`,
      entryKey: "huaweicloud-agent",
      mergeStrategy: "json-object",
      launcher: { ref: "stable-runtime", args: ["router", "--stdio"] },
    },
    skills: {
      source: "canonical",
      targetPath: `{userConfig}/${id}/skills/huaweicloud`,
    },
    approval: {
      mode: "bundled-trusted-companion",
      issuerId: "huaweicloud-mate.local-approval",
      verifierKeyId: "local-approval-ed25519-v1",
    },
    verify: {
      type: "config-process-skill",
      requiresTrustedApprovalProbe: true,
    },
  };
}

async function templateDirectory(): Promise<{ root: string; url: URL }> {
  const root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-hosts-"));
  temporaryRoots.push(root);
  const directory = resolve(root, "templates");
  await mkdir(directory);
  for (const id of ["codex", "claude", "opencode", "codearts"] as const) {
    await writeFile(
      resolve(directory, `${id}.json`),
      `${JSON.stringify(template(id), null, 2)}\n`,
    );
  }
  return { root: directory, url: pathToFileURL(`${directory}/`) };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("declarative host template registry", () => {
  it("requires the exact four-host set and fixed launcher/approval bindings", async () => {
    const directory = await templateDirectory();
    const registry = await HostTemplateRegistry.load(
      directory.url,
      contractDirectory,
    );

    expect(registry.list().map((item) => item.id)).toEqual([
      "codex",
      "claude",
      "opencode",
      "codearts",
    ]);
    expect(registry.get("codex")).toMatchObject({
      mcp: { launcher: { ref: "stable-runtime", args: ["router", "--stdio"] } },
      approval: {
        mode: "bundled-trusted-companion",
        issuerId: "huaweicloud-mate.local-approval",
      },
    });
  });

  it("rejects a template that tries to select another launcher argument", async () => {
    const directory = await templateDirectory();
    const codex = template("codex") as {
      mcp: { launcher: { args: string[] } };
    };
    codex.mcp.launcher.args = ["router", "--unsafe"];
    await writeFile(
      resolve(directory.root, "codex.json"),
      `${JSON.stringify(codex, null, 2)}\n`,
    );

    await expect(
      HostTemplateRegistry.load(directory.url, contractDirectory),
    ).rejects.toMatchObject({ code: "HOST_TEMPLATE_INVALID" });
  });
});
