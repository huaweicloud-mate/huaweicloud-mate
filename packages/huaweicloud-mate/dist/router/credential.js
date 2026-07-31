"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialBroker = void 0;
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
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const CRED_PATH = (0, path_1.join)((0, os_1.homedir)(), ".hcloud", "credentials");
class CredentialBroker {
    config = null;
    constructor() {
        this.load();
    }
    load() {
        if (!(0, fs_1.existsSync)(CRED_PATH)) {
            process.stderr.write(`[credential] WARN: ${CRED_PATH} not found. Credentials not configured.\n`);
            return;
        }
        try {
            const raw = (0, fs_1.readFileSync)(CRED_PATH, "utf-8");
            this.config = this.parseIni(raw);
            process.stderr.write(`[credential] Loaded from ${CRED_PATH}\n`);
        }
        catch (err) {
            process.stderr.write(`[credential] ERROR parsing credentials: ${err.message}\n`);
        }
    }
    /** 简单 INI 解析（仅 [default] section），兼容 hcloud CLI 与自定义格式 */
    parseIni(raw) {
        const config = {};
        let inDefault = false;
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                inDefault = trimmed === "[default]";
                continue;
            }
            if (!inDefault || trimmed.startsWith("#") || trimmed.startsWith(";"))
                continue;
            const eq = trimmed.indexOf("=");
            if (eq === -1)
                continue;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            config[key] = value;
        }
        return {
            huaweicloud_access_key: config.huaweicloud_access_key || config.access_key_id || "",
            huaweicloud_secret_key: config.huaweicloud_secret_key || config.secret_access_key || "",
            huaweicloud_region: config.huaweicloud_region || config.region || "",
        };
    }
    getCredentials() {
        if (!this.config) {
            throw new Error("未配置凭证。请在 ~/.hcloud/credentials 中配置 AK/SK");
        }
        return this.config;
    }
    status() {
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
exports.CredentialBroker = CredentialBroker;
