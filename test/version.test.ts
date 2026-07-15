import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { pluginVersion } from "../src/version.js";

describe("runtime version binding", () => {
  it("matches the package identity used by install manifests and release checks", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly version?: unknown;
    };
    expect(pluginVersion).toBe(packageJson.version);
  });
});
