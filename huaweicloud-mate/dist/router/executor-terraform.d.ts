import type { CredentialConfig, ExecutionResult } from "./types.js";
interface TerraformResult extends ExecutionResult {
    planOutput?: string;
    applyOutput?: string;
    tfDir?: string;
}
export declare class TerraformExecutor {
    plan(capabilityId: string, params: Record<string, any>, credentials: CredentialConfig, correlationId: string): Promise<TerraformResult>;
    apply(tfDir: string, correlationId: string): Promise<TerraformResult>;
    private generateHCL;
    private generateResourceBlock;
    private resolveResource;
    private runTerraform;
    healthCheck(): Promise<Record<string, {
        status: string;
        message?: string;
    }>>;
}
export {};
