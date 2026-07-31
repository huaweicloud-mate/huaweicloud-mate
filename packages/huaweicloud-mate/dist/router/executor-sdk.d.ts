import type { CredentialConfig, ExecutionResult } from "./types.js";
export declare class SDKExecutor {
    execute(capabilityId: string, params: Record<string, any>, credentials: CredentialConfig, correlationId: string): Promise<ExecutionResult>;
    private extractProduct;
    private resolveMethod;
    private ensureSDK;
    private callSDK;
    healthCheck(): Promise<Record<string, {
        status: string;
        message?: string;
    }>>;
}
