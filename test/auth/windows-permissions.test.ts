import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WindowsCredentialPermissionPolicy } from "../../src/auth/permissions.js";

describe("Windows credential permissions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huaweicloud-mate-auth-acl-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")(
    "reduces a credential file to the canonical current-user ACL",
    async () => {
      const path = resolve(root, "credentials.json");
      await writeFile(path, "test", "utf8");
      const policy = new WindowsCredentialPermissionPolicy();

      await expect(policy.secureFile(path)).resolves.toBeUndefined();
      await expect(policy.verifyFile(path)).resolves.toBeUndefined();
    },
  );
});
