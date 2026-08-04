#!/usr/bin/env node
// bin/hc-devkit.js — local MCP stdio server, proxies everything to cloud hc-devkit
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOUD_URL = process.env.HDKITSERVICE_URL || "http://113.45.151.224:3000/mcp";
const HC_DIR = join(homedir(), ".hc-devkit");
const JWT_FILE = join(HC_DIR, "jwt");
const CONFIG_FILE = join(HC_DIR, "config");

let cachedConfig = null;
let authPromise = null;
let configWarned = false;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    cachedConfig = JSON.parse(raw);
    if (cachedConfig.ak && cachedConfig.sk) return cachedConfig;
  } catch {}
  cachedConfig = { ak: process.env.HUAWEICLOUD_AK || "", sk: process.env.HUAWEICLOUD_SK || "", region: process.env.HUAWEICLOUD_REGION || "cn-south-1" };
  return cachedConfig;
}

function loadJwt() {
  try { return readFileSync(JWT_FILE, "utf8").trim(); } catch { return ""; }
}
function saveJwt(token) {
  mkdirSync(HC_DIR, { recursive: true });
  writeFileSync(JWT_FILE, token);
}

async function callCloud(call) {
  const resp = await fetch(CLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(call),
  });
  return resp.json();
}

async function ensureAuth() {
  if (loadJwt()) return;

  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      const cfg = loadConfig();
      if (!cfg.ak || !cfg.sk) {
        if (!configWarned) {
          configWarned = true;
          console.error("[hc-devkit] 未找到凭证配置。请在 ~/.hc-devkit/config 创建文件，内容如下（仅替换 YOUR_ACCESS_KEY 和 YOUR_SECRET_KEY）：");
          console.error("  {");
          console.error('    "ak": "YOUR_ACCESS_KEY",');
          console.error('    "sk": "YOUR_SECRET_KEY",');
          console.error('    "region": "cn-south-1"');
          console.error("  }");
        }
        authPromise = null;
        return;
      }
      const data = await callCloud({
        jsonrpc: "2.0", id: 0, method: "tools/call",
        params: { name: "huaweicloud_auth", arguments: { ak: cfg.ak, sk: cfg.sk, region: cfg.region } },
      });
      const text = data?.result?.content?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed.token) saveJwt(parsed.token);
      }
    } catch (e) {
      console.error(`[hc-devkit] Auto-auth failed: ${e.message}`);
    }
    authPromise = null;
  })();

  return authPromise;
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
      const data = await callCloud({ jsonrpc: "2.0", id: call.id, method: "tools/list" });
      respond(call.id, data.result);
    } catch (e) {
      respond(call.id, { tools: [] });
    }
    return;
  }

  // tools/call → proxy to cloud, auto-inject cached JWT + auto-auth
  if (method === "tools/call") {
    const args = call.params?.arguments || {};
    const toolName = call.params?.name;

    if (toolName !== "huaweicloud_auth") {
      await ensureAuth();
    }

    if (!args.token) {
      const cachedJwt = loadJwt();
      if (cachedJwt) args.token = cachedJwt;
    }

    if (toolName === "huaweicloud_auth" && !args.ak && !args.sk) {
      const cfg = loadConfig();
      if (cfg.ak) args.ak = cfg.ak;
      if (cfg.sk) args.sk = cfg.sk;
      if (!args.region) args.region = cfg.region;
    }

    try {
      const data = await callCloud({
        jsonrpc: "2.0", id: call.id, method: "tools/call",
        params: { name: toolName, arguments: args },
      });

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
