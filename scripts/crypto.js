// scripts/crypto.js — AK/SK 本地加密存储
// 使用 Node.js crypto + 机器指纹派生密钥，确保凭证不出本机

import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const ENC_ALGO = "aes-256-gcm";
const ENV_ENC_FILE = ".env.enc";
const ENV_PLAIN_FILE = ".env";

// 用机器指纹 + 固定 salt 派生 256-bit 密钥
function deriveKey() {
  const fingerprint = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? "default",
  ].join("|");
  return crypto.scryptSync(fingerprint, "huawei-cloud-agent-salt", 32);
}

export function encryptEnv(pluginDir) {
  const src = path.join(pluginDir, ENV_PLAIN_FILE);
  const dest = path.join(pluginDir, ENV_ENC_FILE);
  if (!fs.existsSync(src)) {
    throw new Error(`找不到 ${src}，请先运行 node scripts/setup.js`);
  }
  const plain = fs.readFileSync(src, "utf-8");
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 存储格式: iv(12) + authTag(16) + ciphertext
  const bundle = Buffer.concat([iv, authTag, encrypted]);
  fs.writeFileSync(dest, bundle);
  // 删除明文 .env
  if (fs.existsSync(src)) fs.unlinkSync(src);
  return dest;
}

export function decryptEnv(pluginDir) {
  const dest = path.join(pluginDir, ENV_ENC_FILE);
  const plain = path.join(pluginDir, ENV_PLAIN_FILE);
  // 优先读明文（开发/调试时 setup 刚写入）
  if (fs.existsSync(plain)) {
    return parseEnvFile(plain);
  }
  if (!fs.existsSync(dest)) {
    return null; // 未配置，触发 setup 流程
  }
  const bundle = fs.readFileSync(dest);
  const iv = bundle.subarray(0, 12);
  const authTag = bundle.subarray(12, 28);
  const ciphertext = bundle.subarray(28);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const envText = decrypted.toString("utf-8");
  return parseEnvText(envText);
}

function parseEnvFile(filePath) {
  return parseEnvText(fs.readFileSync(filePath, "utf-8"));
}

function parseEnvText(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}
