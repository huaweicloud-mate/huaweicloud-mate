import { describe, expect, it } from "vitest";
import { OBS_API_COUNT, obsOperations } from "../src/operations/inventory.js";
import { listObsTools, operationSummary } from "../src/server/tools.js";

describe("OBS operation inventory", () => {
  it("registers exactly 94 explicit tools", () => {
    expect(obsOperations).toHaveLength(OBS_API_COUNT);
    expect(listObsTools()).toHaveLength(94);
  });

  it("uses unique tool names and valid input schemas", () => {
    const names = new Set<string>();
    for (const tool of listObsTools()) {
      expect(tool.name).toMatch(/^obs_[a-z0-9_]+$/);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("exposes concise operation summaries", () => {
    const summaries = operationSummary();
    expect(summaries).toHaveLength(94);
    expect(summaries.find((item) => item.apiName === "AppendObject")?.toolName).toBe("obs_append_object");
  });
});
