import { describe, expect, it } from "vitest";

import { defaultRuntimeRoot } from "../../src/installer/paths.js";

describe("default runtime root", () => {
  it("uses the fixed user-level location on every supported platform", () => {
    expect(
      defaultRuntimeRoot("win32", "C:\\Users\\example", {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      }),
    ).toBe("C:\\Users\\example\\AppData\\Local\\hcloud-agent\\runtime");
    expect(defaultRuntimeRoot("darwin", "/Users/example", {})).toBe(
      "/Users/example/Library/Application Support/hcloud-agent/runtime",
    );
    expect(
      defaultRuntimeRoot("linux", "/home/example", {
        XDG_DATA_HOME: "/data/example",
      }),
    ).toBe("/data/example/hcloud-agent/runtime");
    expect(
      defaultRuntimeRoot("win32", "C:\\Users\\fallback", {
        LOCALAPPDATA: "",
      }),
    ).toBe("C:\\Users\\fallback\\AppData\\Local\\hcloud-agent\\runtime");
    expect(
      defaultRuntimeRoot("linux", "/home/fallback", { XDG_DATA_HOME: "" }),
    ).toBe("/home/fallback/.local/share/hcloud-agent/runtime");
  });
});
