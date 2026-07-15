import { describe, expect, it } from "vitest";

import { BrowserApprovalTerminal } from "../../src/approval/browser-ui.js";

function csrfFromPage(page: string): string {
  const match = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/);
  if (match?.[1] === undefined) {
    throw new Error("Approval page did not contain a CSRF token");
  }
  return match[1];
}

describe("browser approval UI", () => {
  it("serves an escaped no-store page and accepts one same-origin approval", async () => {
    let pageBody = "";
    let pageHeaders: Headers | undefined;
    let wrongOriginStatus = 0;
    let repeatedPageStatus = 0;
    const terminal = new BrowserApprovalTerminal(async (url) => {
      const page = await fetch(url);
      pageHeaders = page.headers;
      pageBody = await page.text();
      repeatedPageStatus = (await fetch(url)).status;
      const csrf = csrfFromPage(pageBody);
      const pageUrl = new URL(url);
      const decisionUrl = new URL(`${pageUrl.pathname}/decision`, pageUrl.origin);
      const body = new URLSearchParams({ csrf, decision: "approve" });

      const wrongOrigin = await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://malicious.invalid",
        },
        body,
      });
      wrongOriginStatus = wrongOrigin.status;

      const approved = await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: pageUrl.origin,
        },
        body,
      });
      expect(approved.status).toBe(200);
    });
    terminal.write("Create <script>alert('x')</script> & expose nothing");

    await expect(terminal.readLine("Approve once?")).resolves.toBe("APPROVE");
    expect(wrongOriginStatus).toBe(403);
    expect(repeatedPageStatus).toBe(410);
    expect(pageBody).toContain("&lt;script&gt;");
    expect(pageBody).not.toContain("<script>alert");
    expect(pageHeaders?.get("cache-control")).toContain("no-store");
    expect(pageHeaders?.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(pageHeaders?.get("referrer-policy")).toBe("no-referrer");
    expect(pageHeaders?.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("rejects duplicate or unexpected decision fields", async () => {
    let duplicateStatus = 0;
    const terminal = new BrowserApprovalTerminal(async (url) => {
      const pageUrl = new URL(url);
      const page = await fetch(pageUrl);
      const csrf = csrfFromPage(await page.text());
      const decisionUrl = new URL(`${pageUrl.pathname}/decision`, pageUrl.origin);
      duplicateStatus = (await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: pageUrl.origin,
        },
        body: new URLSearchParams([
          ["csrf", csrf],
          ["csrf", csrf],
          ["decision", "approve"],
        ]),
      })).status;
      await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: pageUrl.origin,
        },
        body: new URLSearchParams({ csrf, decision: "reject" }),
      });
    });

    await expect(terminal.readLine("Approve once?")).resolves.toBe("REJECT");
    expect(duplicateStatus).toBe(403);
  });

  it("returns rejection without producing an approval token", async () => {
    const terminal = new BrowserApprovalTerminal(async (url) => {
      const pageUrl = new URL(url);
      const page = await fetch(pageUrl);
      const csrf = csrfFromPage(await page.text());
      const decisionUrl = new URL(`${pageUrl.pathname}/decision`, pageUrl.origin);
      await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: pageUrl.origin,
        },
        body: new URLSearchParams({ csrf, decision: "reject" }),
      });
    });
    terminal.write("A dangerous operation");

    await expect(terminal.readLine("Approve once?")).resolves.toBe("REJECT");
  });
});
