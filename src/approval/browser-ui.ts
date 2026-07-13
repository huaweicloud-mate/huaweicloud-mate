import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";

import { ApprovalError } from "./errors.js";
import type { ApprovalTerminal } from "./types.js";

export type BrowserOpener = (url: string) => Promise<void>;

const maxDecisionBodyBytes = 4096;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function secureHeaders(contentType: string): Readonly<Record<string, string>> {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function renderApprovalPage(
  actionPath: string,
  csrfToken: string,
  summary: string,
  prompt: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Huawei Cloud operation approval</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 760px; margin: 5vh auto; padding: 24px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid GrayText; border-radius: 8px; padding: 16px; }
    .warning { font-weight: 700; }
    form { display: flex; gap: 12px; justify-content: flex-end; }
    button { padding: 10px 18px; font: inherit; cursor: pointer; }
    .approve { background: #b42318; color: white; border: 1px solid #b42318; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Huawei Cloud operation approval</h1>
    <p class="warning">Review the account, scope, resources, and effects. Approval is valid once.</p>
    <pre>${escapeHtml(summary)}</pre>
    <p>${escapeHtml(prompt)}</p>
    <form method="post" action="${actionPath}">
      <input type="hidden" name="csrf" value="${csrfToken}">
      <button type="submit" name="decision" value="reject">Reject</button>
      <button class="approve" type="submit" name="decision" value="approve">Approve once</button>
    </form>
  </main>
</body>
</html>`;
}

async function readDecisionBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxDecisionBodyBytes) {
      throw new ApprovalError(
        "APPROVAL_UI_FAILED",
        "Approval decision request is too large",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendResponse(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, secureHeaders(contentType));
  response.end(body);
}

export async function openDefaultBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !isAbsolute(systemRoot)) {
      throw new ApprovalError(
        "APPROVAL_UI_FAILED",
        "SystemRoot is unavailable for opening the approval browser",
      );
    }
    command = join(systemRoot, "System32", "rundll32.exe");
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "/usr/bin/open";
    args = [url];
  } else {
    command = "/usr/bin/xdg-open";
    args = [url];
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(
        new ApprovalError(
          "APPROVAL_UI_FAILED",
          `Unable to open the approval browser: ${error.message}`,
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class BrowserApprovalTerminal implements ApprovalTerminal {
  readonly interactive = true;
  #summary = "";
  #used = false;

  constructor(
    private readonly opener: BrowserOpener = openDefaultBrowser,
    private readonly timeoutMs = 300_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
      throw new ApprovalError(
        "APPROVAL_UI_FAILED",
        "Approval browser timeout must be between 1 and 300 seconds",
      );
    }
  }

  write(message: string): void {
    this.#summary += message;
  }

  async readLine(prompt: string): Promise<string> {
    if (this.#used) {
      throw new ApprovalError(
        "APPROVAL_UI_FAILED",
        "Approval browser UI is one-shot",
      );
    }
    this.#used = true;

    const pathToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const pagePath = `/${pathToken}`;
    const decisionPath = `${pagePath}/decision`;

    let resolveDecision!: (decision: string) => void;
    let rejectDecision!: (error: Error) => void;
    const decisionPromise = new Promise<string>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    let settled = false;
    let expectedHost = "";
    let expectedOrigin = "";

    const server = createServer((request, response) => {
      void (async () => {
        if (request.headers.host !== expectedHost) {
          sendResponse(response, 400, "Invalid host");
          return;
        }
        if (request.method === "GET" && request.url === pagePath) {
          sendResponse(
            response,
            200,
            renderApprovalPage(decisionPath, csrfToken, this.#summary, prompt),
            "text/html; charset=utf-8",
          );
          return;
        }
        if (request.method === "POST" && request.url === decisionPath) {
          if (
            request.headers.origin !== expectedOrigin ||
            !request.headers["content-type"]?.startsWith(
              "application/x-www-form-urlencoded",
            )
          ) {
            sendResponse(response, 403, "Invalid approval origin");
            return;
          }
          const values = new URLSearchParams(await readDecisionBody(request));
          if (values.get("csrf") !== csrfToken) {
            sendResponse(response, 403, "Invalid approval token");
            return;
          }
          const decision = values.get("decision");
          if (decision !== "approve" && decision !== "reject") {
            sendResponse(response, 400, "Invalid approval decision");
            return;
          }
          sendResponse(
            response,
            200,
            decision === "approve"
              ? "Approved. You may close this tab."
              : "Rejected. You may close this tab.",
          );
          if (!settled) {
            settled = true;
            resolveDecision(decision === "approve" ? "APPROVE" : "REJECT");
          }
          server.close();
          return;
        }
        sendResponse(response, 404, "Not found");
      })().catch((error: unknown) => {
        if (!response.headersSent) {
          sendResponse(response, 400, "Invalid approval request");
        } else {
          response.destroy();
        }
        if (!settled) {
          settled = true;
          rejectDecision(
            error instanceof ApprovalError
              ? error
              : new ApprovalError(
                  "APPROVAL_UI_FAILED",
                  "Approval browser request failed",
                ),
          );
          server.close();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    expectedHost = `127.0.0.1:${address.port}`;
    expectedOrigin = `http://${expectedHost}`;
    const pageUrl = `${expectedOrigin}${pagePath}`;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectDecision(
          new ApprovalError(
            "APPROVAL_PROCESS_TIMEOUT",
            "Approval browser timed out",
          ),
        );
        server.close();
      }
    }, this.timeoutMs);
    timeout.unref();

    try {
      await this.opener(pageUrl);
      return await decisionPromise;
    } catch (error) {
      if (!settled) {
        settled = true;
        server.close();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  }
}
