/**
 * JsonlAuditWriter — JSONL 审计日志
 *
 * 首版：追加写入 ~/.hcloud-agent/logs/audit-{date}.jsonl
 * 每行一个 JSON，支持 jq/grep 查询
 * 二期：接口预留 SqliteAuditWriter / ElasticAuditWriter
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AuditEntry } from "./types.js";

const LOG_DIR = join(homedir(), ".hcloud-agent", "logs");

export class JsonlAuditWriter {
  private path: string;

  constructor() {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    }
    const date = new Date().toISOString().slice(0, 10);
    this.path = join(LOG_DIR, `audit-${date}.jsonl`);
  }

  write(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch (err: any) {
      process.stderr.write(`[audit] Write error: ${err.message}\n`);
    }
  }
}
