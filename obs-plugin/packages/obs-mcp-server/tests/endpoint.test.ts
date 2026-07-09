import { describe, expect, it } from "vitest";
import { resolveEndpoint } from "../src/provider/endpoint.js";

describe("OBS endpoint resolver", () => {
  it("builds default regional endpoint", () => {
    const url = resolveEndpoint({
      region: "cn-north-4",
      bucket: "bucket-a",
      key: "folder/file.txt"
    });
    expect(url.toString()).toBe("https://obs.cn-north-4.myhuaweicloud.com/bucket-a/folder/file.txt");
  });

  it("supports custom endpoints and boolean subresources", () => {
    const url = resolveEndpoint({
      region: "cn-north-4",
      endpoint: "https://example.com",
      bucket: "bucket-a",
      query: {
        acl: true,
        marker: "next"
      }
    });
    expect(url.toString()).toBe("https://example.com/bucket-a?acl=&marker=next");
  });
});
