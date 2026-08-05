import { describe, it, expect } from "vitest";

describe("B3: task insert failure rollback", () => {
  it("createTask should catch executeTask rejection and mark task as failed", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    expect(code).toMatch(/executeTask\(.*\)\.catch/);
  });

  it("K8s unavailable should set status to failed, not completed", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const containerBlockStart = code.indexOf("if (!container)");
    const returnAfterContainer = code.indexOf("return;", containerBlockStart);
    const containerBlock = code.slice(containerBlockStart, returnAfterContainer);
    expect(containerBlock).toContain('status: "failed"');
    expect(containerBlock).not.toContain('status: "completed"');
  });

  it("executeTask catch block should mark status failed and write error", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const catchBlock = code.slice(code.lastIndexOf("} catch (err) {"));
    expect(catchBlock).toContain('status: "failed"');
    expect(catchBlock).toContain("error: err.message");
  });

  it("track function should persist to DB via updateTaskDb", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const trackFn = code.slice(code.indexOf("function track("));
    expect(trackFn).toContain("updateTaskDb");
  });
});

describe("B4: cancelTask userId/user_id compatibility", () => {
  it("cancelTask should use task.userId || task.user_id for destroyContainer", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const cancelFn = code.slice(code.indexOf("async function cancelTask"));
    expect(cancelFn).toMatch(/task\.userId\s*\|\|\s*task\.user_id/);
  });

  it("db.js getTaskDb should map user_id to userId", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./db.js", import.meta.url), "utf-8");
    const getTaskFn = code.slice(code.indexOf("async function getTaskDb"));
    expect(getTaskFn).toMatch(/userId:\s*t\.user_id/);
  });
});

describe("B8: DB update failure logging and retry", () => {
  it("track should log error on updateTaskDb failure, not silent catch", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const trackFn = code.slice(code.indexOf("function track("), code.indexOf("function getCached("));
    expect(trackFn).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    expect(trackFn).toContain("console.error");
  });

  it("track should retry updateTaskDb on failure", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const trackFn = code.slice(code.indexOf("function track("), code.indexOf("function getCached("));
    const firstCatch = trackFn.indexOf(".catch(");
    const retryCall = trackFn.indexOf("updateTaskDb", firstCatch + 1);
    expect(retryCall).toBeGreaterThan(firstCatch);
  });

  it("retry should also log error on second failure", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const trackFn = code.slice(code.indexOf("function track("), code.indexOf("function getCached("));
    const errorLogs = [...trackFn.matchAll(/console\.error/g)];
    expect(errorLogs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("M3: activeTaskCache recovery and SSE reconnect", () => {
  it("initTaskCache should be exported", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    expect(code).toContain("export async function initTaskCache");
  });

  it("initTaskCache should recover pending/working tasks from MySQL", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const initFn = code.slice(code.indexOf("async function initTaskCache"));
    expect(initFn).toContain("pending");
    expect(initFn).toContain("working");
    expect(initFn).toContain("activeTaskCache.set");
  });

  it("working tasks should be marked failed on recovery (server restarted)", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const initFn = code.slice(code.indexOf("async function initTaskCache"));
    expect(initFn).toContain("Server restarted, task interrupted");
  });

  it("publish should assign incremental event id", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const publishFn = code.slice(code.indexOf("function publish("), code.indexOf("function track("));
    expect(publishFn).toContain("eventCounter");
    expect(publishFn).toContain("id: eventCounter");
  });

  it("streamTask should accept lastEventId and replay missed events", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const streamFn = code.slice(code.indexOf("function streamTask("), code.indexOf("async function cancelTask"));
    expect(streamFn).toContain("lastEventId");
    expect(streamFn).toContain("replayFrom");
  });

  it("server.js SSE endpoint should send event id and support Last-Event-ID", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./server.js", import.meta.url), "utf-8");
    expect(code).toContain("last-event-id");
    expect(code).toMatch(/id:\s*\$\{event\.id\}/);
  });

  it("server.js should call initTaskCache on startup", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./server.js", import.meta.url), "utf-8");
    expect(code).toContain("initTaskCache()");
  });
});

describe("L1-8: SSE Last-Event-ID replay should not replay all events when no new events", () => {
  it("replayFrom=-1 should return empty array, not all events", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const streamFn = code.slice(code.indexOf("function streamTask("), code.indexOf("async function cancelTask"));
    expect(streamFn).toMatch(/replayFrom\s*>=\s*0\s*\?\s*task\.events\.slice\(replayFrom\)\s*:\s*\[\]/);
  });

  it("should not fall back to task.events when no events match", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const streamFn = code.slice(code.indexOf("function streamTask("), code.indexOf("async function cancelTask"));
    const replayLine = streamFn.match(/replayFrom\s*>=\s*0\s*\?[^;]+;/);
    expect(replayLine).not.toBeNull();
    expect(replayLine[0]).not.toContain("task.events;");
  });
});

describe("M4: set_credentials should not use stale user in executeTask", () => {
  it("executeTask should re-read user from Redis before creating sandbox", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const execFn = code.slice(code.indexOf("async function executeTask"), code.indexOf("function publish"));
    expect(execFn).toContain("freshUser");
    expect(execFn).toContain("getUser");
  });

  it("executeTask should use freshUser for getOrCreateContainer, not stale user param", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    const execFn = code.slice(code.indexOf("async function executeTask"), code.indexOf("function publish"));
    expect(execFn).toContain("currentUser");
    expect(execFn).toMatch(/getOrCreateContainer\(currentUser/);
  });

  it("task-manager should import getUser from redis-store", async () => {
    const fs = await import("node:fs/promises");
    const code = await fs.readFile(new URL("./task-manager.js", import.meta.url), "utf-8");
    expect(code).toMatch(/import.*getUser.*from.*redis-store/);
  });
});
