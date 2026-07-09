import { describe, expect, it } from "vitest";
import { buildStringToSign, signObsRequest } from "../src/provider/signer.js";

describe("OBS signer", () => {
  it("builds canonical string with OBS headers and subresources", () => {
    const url = new URL("https://obs.cn-north-4.myhuaweicloud.com/example/key.txt?acl=&marker=ignored");
    const canonical = buildStringToSign("GET", url, {
      Date: "Tue, 27 Mar 2007 19:36:42 +0000",
      "x-obs-meta-name": "demo"
    });
    expect(canonical).toBe("GET\n\n\nTue, 27 Mar 2007 19:36:42 +0000\nx-obs-meta-name:demo\n/example/key.txt?acl");
  });

  it("adds authorization and security token headers", () => {
    const signed = signObsRequest({
      method: "GET",
      url: new URL("https://obs.cn-north-4.myhuaweicloud.com/"),
      headers: {
        Date: "Tue, 27 Mar 2007 19:36:42 +0000"
      },
      accessKeyId: "ak",
      secretAccessKey: "sk",
      securityToken: "token"
    });
    expect(signed.authorization).toMatch(/^OBS ak:/);
    expect(signed["x-obs-security-token"]).toBe("token");
  });
});
