import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { ecsCapabilityRegistrations } from "../../src/catalog/ecs.js";
import { StaticCapabilityCatalog } from "../../src/catalog/static-catalog.js";

const contractDirectory = pathToFileURL(`${resolve("docs/契约")}/`);

describe("static ECS capability catalog", () => {
  it("publishes one bounded sensitive-read KooCLI capability", async () => {
    const catalog = await StaticCapabilityCatalog.create(
      ecsCapabilityRegistrations,
      contractDirectory,
    );

    expect(catalog.search({
      schemaVersion: "huaweicloud-agent-search-input/v1-lite",
      query: "ecs server",
      product: "ecs",
      operationKind: "read",
      riskTags: ["sensitive-read"],
    }).capabilities).toEqual([{
      capabilityId: "huaweicloud.ecs.server.list.v1",
      product: "ecs",
      summary: "List bounded ECS server identities and statuses through KooCLI",
      operationKind: "read",
      riskTags: ["sensitive-read"],
      executors: ["koocli"],
      defaultExecutor: "koocli",
    }]);

    const capability = catalog.describe({
      schemaVersion: "huaweicloud-agent-describe-input/v1-lite",
      capabilityId: "huaweicloud.ecs.server.list.v1",
    }).capability;
    expect(capability).toMatchObject({
      scope: { region: "required", project: "required" },
      confirmationRequired: true,
      executors: {
        koocli: { service: "ECS", operation: "ListServersDetails" },
      },
    });
    expect(capability.executors.providerMcp).toBeUndefined();
  });
});
