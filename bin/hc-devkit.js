#!/usr/bin/env node
// bin/hc-devkit.js — local MCP stdio server, proxies to cloud hc-devkit
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOUD_URL = process.env.HDKITSERVICE_URL || "http://113.45.151.224:3000/mcp";
const JWT_FILE = join(homedir(), ".hc-devkit", "jwt");

// JWT persistence
function loadJwt() {
  try { return readFileSync(JWT_FILE, "utf8").trim(); } catch { return ""; }
}
function saveJwt(token) {
  mkdirSync(join(homedir(), ".hc-devkit"), { recursive: true });
  writeFileSync(JWT_FILE, token);
}

// MCP stdio handler
const rl = createInterface({ input: process.stdin });
let nextId = 1;

rl.on("line", async (line) => {
  if (!line.trim()) return; // skip empty
  let call;
  try { call = JSON.parse(line); } catch { return; }

  const method = call.method;

  // initialize / notifications
  if (method === "initialize") {
    return respond(call.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hc-devkit", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return;

  // tools/list
  if (method === "tools/list") {
    return respond(call.id, {
      tools: [
        { name: "huaweicloud_auth",          description: "认证并获取JWT",           inputSchema: { type:"object", properties:{ ak:{type:"string"},sk:{type:"string"},region:{type:"string"} } } },
        { name: "huaweicloud_set_credentials",description: "更新AK/SK",              inputSchema: { type:"object", properties:{ token:{type:"string"},ak:{type:"string"},sk:{type:"string"},region:{type:"string"}}, required:["token","ak","sk"] } },
        { name: "huaweicloud_voucher_status", description: "查代金券状态",            inputSchema: { type:"object", properties:{ token:{type:"string"}}, required:["token"] } },
        { name: "huaweicloud_voucher_claim",  description: "领取代金券（一人一次）",  inputSchema: { type:"object", properties:{ token:{type:"string"}}, required:["token"] } },
        { name: "huaweicloud_invoke",          description: "操作华为云资源",          inputSchema: { type:"object", properties:{ intent:{type:"string"}, token:{type:"string"}}, required:["intent"] } },
      ],
    });
  }

  // tools/call — proxy to cloud
  if (method === "tools/call") {
    const toolName = call.params?.name;
    const args = call.params?.arguments || {};

    // Auto-inject JWT for invoke, set_credentials etc.
    if (["huaweicloud_invoke", "huaweicloud_set_credentials", "huaweicloud_voucher_status", "huaweicloud_voucher_claim"].includes(toolName)) {
      if (!args.token) {
        const cachedJwt = loadJwt();
        if (cachedJwt) args.token = cachedJwt;
      }
    }

    try {
      const resp = await fetch(CLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call", params: { name: toolName, arguments: args } }),
      });
      const data = await resp.json();

      // Extract JWT from auth response and persist
      if (toolName === "huaweicloud_auth" && data?.result?.content?.[0]?.text) {
        const t = JSON.parse(data.result.content[0].text);
        if (t.token) saveJwt(t.token);
      }

      respond(call.id, data.result);
    } catch (e) {
      respond(call.id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
