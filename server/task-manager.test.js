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
    expect(getTaskFn).toMatch(/userId:\s*r\.user_id/);
  });
});
