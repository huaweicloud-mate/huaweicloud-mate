#!/usr/bin/env node
// bin/hc-devkit.js — local MCP stdio server, proxies everything to cloud hc-devkit
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOUD_URL = process.env.HDKITSERVICE_URL || "http://113.45.151.224:3000/mcp";
const JWT_FILE = join(homedir(), ".hc-devkit", "jwt");

function loadJwt() {
  try { return readFileSync(JWT_FILE, "utf8").trim(); } catch { return ""; }
}
function saveJwt(token) {
  mkdirSync(join(homedir(), ".hc-devkit"), { recursive: true });
  writeFileSync(JWT_FILE, token);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let call;
  try { call = JSON.parse(line); } catch { return; }

  const method = call.method;

  // initialize / notifications — handled locally
  if (method === "initialize") {
    return respond(call.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "hc-devkit", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return;

  // tools/list → proxy to cloud
  if (method === "tools/list") {
    try {
      const resp = await fetch(CLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/list" }),
      });
      const data = await resp.json();
      respond(call.id, data.result);
    } catch (e) {
      respond(call.id, { tools: [] });
    }
    return;
  }

  // tools/call → proxy to cloud, auto-inject cached JWT
  if (method === "tools/call") {
    const args = call.params?.arguments || {};
    const toolName = call.params?.name;

    // Auto-inject JWT for tools that need it
    if (!args.token) {
      const cachedJwt = loadJwt();
      if (cachedJwt) args.token = cachedJwt;
    }

    try {
      const resp = await fetch(CLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      const data = await resp.json();

      // Persist JWT from auth response
      if (toolName === "huaweicloud_auth" && data?.result?.content?.[0]?.text) {
        try {
          const t = JSON.parse(data.result.content[0].text);
          if (t.token) saveJwt(t.token);
        } catch (e) {
          console.error(`[hc-devkit] Failed to parse auth response: ${e.message}`);
        }
      }

      if (data.result) {
        respond(call.id, data.result);
      } else {
        respond(call.id, { content: [{ type: "text", text: data.error?.message || "Cloud error" }], isError: true });
      }
    } catch (e) {
      respond(call.id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
    return;
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
