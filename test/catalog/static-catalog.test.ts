import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { developmentCapabilityRegistrations } from "../../src/catalog/development.js";
import { StaticCapabilityCatalog } from "../../src/catalog/static-catalog.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

describe("static development capability catalog", () => {
  it("searches deterministically and binds cursors to the original query", async () => {
    const catalog = await StaticCapabilityCatalog.create(
      developmentCapabilityRegistrations,
      contractDirectory,
    );
    const first = catalog.search({
      schemaVersion: "huaweicloud-agent-search-input/v1-lite",
      query: "*",
      limit: 1,
    });

    expect(first.capabilities).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = catalog.search({
      schemaVersion: "huaweicloud-agent-search-input/v1-lite",
      query: "*",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.capabilities).toHaveLength(1);
    expect(second.capabilities[0]?.capabilityId).not.toBe(
      first.capabilities[0]?.capabilityId,
    );
    expect(second.nextCursor).toBeUndefined();

    expect(() =>
      catalog.search({
        schemaVersion: "huaweicloud-agent-search-input/v1-lite",
        query: "different",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_MISMATCH" }));
  });

  it("filters risk metadata and returns the frozen capability definition", async () => {
    const catalog = await StaticCapabilityCatalog.create(
      developmentCapabilityRegistrations,
      contractDirectory,
    );
    const search = catalog.search({
      schemaVersion: "huaweicloud-agent-search-input/v1-lite",
      query: "reference",
      operationKind: "write",
      riskTags: ["privileged"],
    });

    expect(search.capabilities).toEqual([
      expect.objectContaining({
        capabilityId: "huaweicloud.reference.change.simulate.v1",
        operationKind: "write",
        riskTags: ["privileged"],
        executors: ["provider-mcp"],
      }),
    ]);
    expect(
      catalog.describe({
        schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
        capabilityId: "huaweicloud.reference.change.simulate.v1",
      }).capability.outputPolicy.sensitivePaths,
    ).toEqual(["/internalTrace"]);
  });

  it("rejects unknown capability descriptions", async () => {
    const catalog = await StaticCapabilityCatalog.create(
      developmentCapabilityRegistrations,
      contractDirectory,
    );

    expect(() =>
      catalog.describe({
        schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
        capabilityId: "huaweicloud.reference.missing.v1",
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_FOUND" }));
  });
});
