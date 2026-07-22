// scripts/setup.js — v2 多租户版，配置云端 API Server 连接

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptEnv } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");
const envFile = path.join(pluginDir, ".env");

function ask(rl, question, sensitive = false) {
  return new Promise((resolve) => {
    if (sensitive) {
      const stdin = process.stdin;
      process.stdout.write(question);
      let buf = "";
      const onData = (c) => {
        c = c.toString();
        if (c === "\r" || c === "\n") {
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\x7f" || c === "\b") {
          if (buf.length > 0) buf = buf.slice(0, -1);
          return;
        }
        buf += c;
      };
      stdin.setRawMode(true);
      stdin.on("data", onData);
    } else {
      rl.question(question, resolve);
    }
  });
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  华为云 Agent 凭证配置（v2 · 多租户版）");
  console.log("═══════════════════════════════════════════\n");
  console.log("此配置仅需运行一次，AK/SK 将加密存储于本地。\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ak = await ask(rl, "华为云 Access Key (AK): ", true);
  if (!ak) { console.log("AK 不能为空，已取消。"); process.exit(1); }

  const sk = await ask(rl, "华为云 Secret Key (SK): ", true);
  if (!sk) { console.log("SK 不能为空，已取消。"); process.exit(1); }

  const projectId = await ask(rl, "项目 ID (Project ID): ");
  const region = await ask(rl, "区域 (默认: cn-north-4): ") || "cn-north-4";

  const apiBase = await ask(rl, "云端 API Server 地址 (如 https://1.2.3.4:3000): ");
  if (!apiBase) { console.log("API 地址不能为空，已取消。"); process.exit(1); }

  const openaiKey = await ask(rl, "OpenAI API Key (可选，为空则用服务端默认): ", true);

  rl.close();

  const lines = [
    "# 华为云 Agent 凭证 — v2 多租户版",
    `HUAWEI_AK=${ak}`,
    `HUAWEI_SK=${sk}`,
    `HUAWEI_PROJECT_ID=${projectId}`,
    `HUAWEI_REGION=${region}`,
    `API_BASE=${apiBase}`,
  ];
  if (openaiKey) lines.push(`OPENAI_API_KEY=${openaiKey}`);

  fs.writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  console.log("\n✓ 凭证已写入 .env");

  const encPath = encryptEnv(pluginDir);
  console.log(`✓ 已加密存储到 ${path.relative(pluginDir, encPath)}`);
  console.log(`\n配置完成！`);

  // 测试连接
  console.log(`\n正在测试连接 ${apiBase}...`);
  try {
    const { signRequest } = await import("./huawei-client.js");
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const urlObj = new URL(apiBase + "/api/v1/health");
    const headers = {
      "Content-Type": "application/json",
      "Host": urlObj.host,
      "X-HW-Timestamp": timestamp,
    };
    const { authorization } = signRequest(ak, sk, region, "codex-agent", "GET", "/api/v1/health", "", headers, "");
    headers["Authorization"] = authorization;

    const resp = await fetch(urlObj.href, { method: "GET", headers });
    const data = await resp.json();
    console.log(`✓ 连接成功！状态: ${data.status}, 用户数: ${data.users}`);
  } catch (e) {
    console.log(`⚠ 无法连接: ${e.message}（请确认 API Server 已启动）`);
  }
}

main().catch((e) => {
  console.error("配置失败:", e.message);
  process.exit(1);
});
