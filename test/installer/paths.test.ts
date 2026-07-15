import { describe, expect, it } from "vitest";

import {
  defaultAuditLogPath,
  defaultCredentialsPath,
  defaultRuntimeRoot,
} from "../../src/installer/paths.js";

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

describe("default audit log path", () => {
  it("uses a fixed user data path outside the replaceable runtime", () => {
    expect(defaultAuditLogPath("win32", "C:\\Users\\example", {
      LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
    })).toBe(
      "C:\\Users\\example\\AppData\\Local\\hcloud-agent\\logs\\router.jsonl",
    );
    expect(defaultAuditLogPath("darwin", "/Users/example", {})).toBe(
      "/Users/example/Library/Application Support/hcloud-agent/logs/router.jsonl",
    );
    expect(defaultAuditLogPath("linux", "/home/example", {
      XDG_DATA_HOME: "/data/example",
    })).toBe("/data/example/hcloud-agent/logs/router.jsonl");
  });
});

describe("default credentials path", () => {
  it("keeps credentials outside the replaceable runtime directory", () => {
    expect(
      defaultCredentialsPath("win32", "C:\\Users\\example", {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      }),
    ).toBe("C:\\Users\\example\\AppData\\Local\\hcloud-agent\\credentials.json");
    expect(defaultCredentialsPath("darwin", "/Users/example", {})).toBe(
      "/Users/example/Library/Application Support/hcloud-agent/credentials.json",
    );
    expect(
      defaultCredentialsPath("linux", "/home/example", {
        XDG_DATA_HOME: "/data/example",
      }),
    ).toBe("/data/example/hcloud-agent/credentials.json");
  });
});
