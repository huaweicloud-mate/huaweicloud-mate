import type { CredentialConfig } from "./types.js";
export declare class CredentialBroker {
    private config;
    constructor();
    private load;
    /** 简单 INI 解析（仅 [default] section） */
    private parseIni;
    getCredentials(): CredentialConfig;
    status(): {
        status: string;
        region?: string;
    };
}
