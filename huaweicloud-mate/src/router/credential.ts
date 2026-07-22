/**
 * CredentialBroker — 凭证代理
 *
 * 首版：从 ~/.hcloud/credentials 读取 AK/SK
 * 格式: INI
 *   [default]
 *   huaweicloud_access_key = AK***
 *   huaweicloud_secret_key = SK***
 *   huaweicloud_region = cn-north-4
 */
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { CredentialConfig } from "./types.js";

const CRED_PATH = join(homedir(), ".hcloud", "credentials");

export class CredentialBroker {
  private config: CredentialConfig | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(CRED_PATH)) {
      process.stderr.write(
        `[credential] WARN: ${CRED_PATH} not found. Credentials not configured.\n`
      );
      return;
    }
    try {
      const raw = readFileSync(CRED_PATH, "utf-8");
      this.config = this.parseIni(raw);
      process.stderr.write(`[credential] Loaded from ${CRED_PATH}\n`);
    } catch (err: any) {
      process.stderr.write(`[credential] ERROR parsing credentials: ${err.message}\n`);
    }
  }

  /** 简单 INI 解析（仅 [default] section） */
  private parseIni(raw: string): CredentialConfig {
    const config: any = {};
    let inDefault = false;

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inDefault = trimmed === "[default]";
        continue;
      }
      if (!inDefault || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      config[key] = value;
    }

    return {
      huaweicloud_access_key: config.huaweicloud_access_key || "",
      huaweicloud_secret_key: config.huaweicloud_secret_key || "",
      huaweicloud_region: config.huaweicloud_region || "",
    };
  }

  getCredentials(): CredentialConfig {
    if (!this.config) {
      throw new Error("未配置凭证。请在 ~/.hcloud/credentials 中配置 AK/SK");
    }
    return this.config;
  }

  status(): { status: string; region?: string } {
    if (!this.config) {
      return { status: "not_configured" };
    }
    const hasAk = this.config.huaweicloud_access_key.length >= 16;
    const hasSk = this.config.huaweicloud_secret_key.length >= 16;
    return {
      status: hasAk && hasSk ? "configured" : "incomplete",
      region: this.config.huaweicloud_region,
    };
  }
}
