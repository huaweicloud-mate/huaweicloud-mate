#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const A2A_URL = "http://127.0.0.1:3000";
const POLL_INTERVAL = 1000;
const MAX_POLLS = 35;

function getLocalIp() {
  try {
    return execSync("hostname -I", { encoding: "utf8" }).trim().split(/\s+/)[0] || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

async function main() {
  let loginResp;
  try {
    loginResp = await fetch(`${A2A_URL}/auth/login`, { method: "POST" });
  } catch {
    console.error(JSON.stringify({ success: false, error: "无法连接 A2A Server" }));
    process.exit(2);
  }
  const { code } = await loginResp.json();
  const ip = getLocalIp();
  const loginUrl = `http://${ip}:3000/auth/confirm/${code}`;

  try {
    const QRCode = await import("qrcode");
    const qrText = await QRCode.toString(loginUrl, { type: "terminal", small: true });
    console.log("\n┌─ 请扫码登录 Huawei Cloud Agent ──────────────────────────┐");
    console.log("│                                                           │");
    qrText.split("\n").forEach(line => console.log("│  " + line));
    console.log("│                                                           │");
    console.log(`│  确认码: ${code}               有效期: 30 秒                   │`);
    console.log("│  (扫码失败? 把确认码粘贴到聊天框即可)                       │");
    console.log("└───────────────────────────────────────────────────────────┘\n");
  } catch {
    console.log(`确认码: ${code}   (qrcode 模块异常，无法显示二维码)`);
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    let pollResp;
    try {
      pollResp = await fetch(`${A2A_URL}/auth/token/${code}`);
    } catch {
      console.error(JSON.stringify({ success: false, error: "轮询网络错误" }));
      process.exit(2);
    }
    const result = await pollResp.json();

    if (result.expired) {
      console.error(JSON.stringify({ success: false, error: "确认码已过期" }));
      process.exit(1);
    }

    if (result.confirmed && result.token) {
      const configPath = join(homedir(), ".config", "opencode", "opencode.json");
      let config = {};
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, "utf8"));
      }
      if (!config.mcp) config.mcp = {};
      if (!config.mcp["huaweicloud-agent"]) config.mcp["huaweicloud-agent"] = {};
      if (!config.mcp["huaweicloud-agent"].headers) config.mcp["huaweicloud-agent"].headers = {};
      config.mcp["huaweicloud-agent"].headers.Authorization = `Bearer ${result.token}`;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

      console.log(JSON.stringify({ success: true, token: result.token.substring(0, 20) + "..." }));
      process.exit(0);
    }
  }

  console.error(JSON.stringify({ success: false, error: "等待超时" }));
  process.exit(1);
}

main();
