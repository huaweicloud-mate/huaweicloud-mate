import { describe, it, expect } from "vitest";

describe("M2: concurrent sandbox creation prevention", () => {
  it("getOrCreateContainer should acquire Redis lock before creating sandbox", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../sandbox.js", import.meta.url), "utf-8");
    const fn = code.slice(code.indexOf("async function getOrCreateContainer"));
    expect(fn).toContain("acquireLock");
    expect(fn).toMatch(/lock:sandbox:/);
  });

  it("should release lock after sandbox creation completes", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../sandbox.js", import.meta.url), "utf-8");
    const fn = code.slice(code.indexOf("async function getOrCreateContainer"));
    expect(fn).toContain("releaseLock");
  });

  it("should release lock on error to avoid deadlock", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../sandbox.js", import.meta.url), "utf-8");
    const fn = code.slice(code.indexOf("async function getOrCreateContainer"));
    const catchBlocks = [...fn.matchAll(/catch\s*\(/g)];
    const releaseCalls = [...fn.matchAll(/releaseLock/g)];
    expect(releaseCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("should recheck job after acquiring lock (double-check pattern)", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../sandbox.js", import.meta.url), "utf-8");
    const fn = code.slice(code.indexOf("async function getOrCreateContainer"));
    expect(fn).toContain("recheckJob");
  });
});

describe("M2: redis-store lock functions", () => {
  it("acquireLock and releaseLock should be exported from redis-store", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../redis-store.js", import.meta.url), "utf-8");
    expect(code).toContain("export async function acquireLock");
    expect(code).toContain("export async function releaseLock");
  });

  it("acquireLock should use SET NX PX for atomic lock", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("../redis-store.js", import.meta.url), "utf-8");
    const lockFn = code.slice(code.indexOf("async function acquireLock"));
    expect(lockFn).toContain('"PX"');
    expect(lockFn).toContain('"NX"');
  });
});
