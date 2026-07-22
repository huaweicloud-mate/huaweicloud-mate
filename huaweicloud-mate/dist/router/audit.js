"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonlAuditWriter = void 0;
/**
 * JsonlAuditWriter — JSONL 审计日志
 *
 * 首版：追加写入 ~/.hcloud-agent/logs/audit-{date}.jsonl
 * 每行一个 JSON，支持 jq/grep 查询
 * 二期：接口预留 SqliteAuditWriter / ElasticAuditWriter
 */
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const LOG_DIR = (0, path_1.join)((0, os_1.homedir)(), ".hcloud-agent", "logs");
class JsonlAuditWriter {
    path;
    constructor() {
        if (!(0, fs_1.existsSync)(LOG_DIR)) {
            (0, fs_1.mkdirSync)(LOG_DIR, { recursive: true, mode: 0o700 });
        }
        const date = new Date().toISOString().slice(0, 10);
        this.path = (0, path_1.join)(LOG_DIR, `audit-${date}.jsonl`);
    }
    write(entry) {
        try {
            const line = JSON.stringify(entry) + "\n";
            (0, fs_1.appendFileSync)(this.path, line, { mode: 0o600 });
        }
        catch (err) {
            process.stderr.write(`[audit] Write error: ${err.message}\n`);
        }
    }
}
exports.JsonlAuditWriter = JsonlAuditWriter;
