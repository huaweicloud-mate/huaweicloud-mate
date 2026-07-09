import { describe, expect, it } from "vitest";
import { loadObsEnv } from "../src/config/env.js";

describe("OBS environment loader", () => {
  it("uses HUAWEICLOUD_OBS_SERVER as an endpoint alias", () => {
    const env = loadObsEnv({
      HUAWEICLOUD_ACCESS_KEY_ID: "ak",
      HUAWEICLOUD_SECRET_ACCESS_KEY: "sk",
      HUAWEICLOUD_OBS_SERVER: "https://obs.cn-north-4.myhuaweicloud.com"
    });

    expect(env.endpoint).toBe("https://obs.cn-north-4.myhuaweicloud.com");
  });
});
