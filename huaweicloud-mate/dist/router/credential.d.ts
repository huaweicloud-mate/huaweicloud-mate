import type { CredentialConfig } from "./types.js";
export declare class CredentialBroker {
    private config;
    constructor();
    private load;
    /** 简单 INI 解析（仅 [default] section），兼容 hcloud CLI 与自定义格式 */
    private parseIni;
    getCredentials(): CredentialConfig;
    status(): {
        status: string;
        region?: string;
    };
}
