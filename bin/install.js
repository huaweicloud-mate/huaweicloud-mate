#!/usr/bin/env node
/**
 * huaweicloud-mate-codex Installer
 *
 * 一行命令安装: npx huaweicloud-mate-codex
 *
 * 自动完成:
 *   1. 检测 Codex 安装
 *   2. 配置 MCP Server
 *   3. 配置凭证引导
 */
const { existsSync, mkdirSync, writeFileSync, readFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");
const { execSync } = require("child_process");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function log(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}→${RESET} ${msg}`); }

async function main() {
  console.log(`\n${BOLD}huaweicloud-mate-codex v0.0.1${RESET}\n`);

  // ─── 1. Ensure huaweicloud-mate installed ───
  info("Step 1/4: Checking huaweicloud-mate...");
  try {
    execSync("huaweicloud-mate --help 2>/dev/null", { stdio: "ignore", timeout: 3000 });
    log("huaweicloud-mate already installed");
  } catch {
    warn("huaweicloud-mate not found, installing...");
    execSync("npm install -g huaweicloud-mate@0.0.1 --registry https://registry.npmjs.org/", { stdio: "inherit" });
    log("huaweicloud-mate installed");
  }

  // ─── 2. Check Codex ───
  info("Step 2/4: Checking Codex...");
  const codexDir = join(homedir(), ".codex");
  const mcpJsonPath = join(codexDir, "mcp.json");

  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
    log(`Created ${codexDir}`);
  }

  // ─── 3. Configure MCP ───
  info("Step 3/4: Configuring Codex MCP...");
  let mcpConfig = {};
  if (existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    } catch {}
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  if (mcpConfig.mcpServers["华为云"]) {
    log("华为云 already configured in Codex");
  } else {
    mcpConfig.mcpServers["华为云"] = {
      command: "huaweicloud-mate",
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
    log(`Added 华为云 to ${mcpJsonPath}`);
  }

  // ─── 4. Credential reminder ───
  info("Step 4/4: Credential...");
  const credFile = join(homedir(), ".hcloud", "credentials");

  console.log("");
  if (existsSync(credFile)) {
    log("Credentials already configured ✅");
  } else {
    console.log(`  ${YELLOW}Credentials not configured.${RESET}`);
    console.log(`  Create ${credFile}:`);
    console.log("");
    console.log(`    [default]`);
    console.log(`    huaweicloud_access_key = YOUR_AK`);
    console.log(`    huaweicloud_secret_key = YOUR_SK`);
    console.log(`    huaweicloud_region = cn-north-4`);
  }

  console.log("");
  console.log(`${BOLD}${GREEN}Done!${RESET} Restart Codex and try:`);
  console.log(`  "${CYAN}检查 huaweicloud-mate 的连接状态${RESET}"`);
  console.log(`  "${CYAN}搜索 VPC 子网有哪些操作${RESET}"`);
  console.log("");
}

main().catch((err) => {
  console.error("Install failed:", err.message);
  process.exit(1);
});
