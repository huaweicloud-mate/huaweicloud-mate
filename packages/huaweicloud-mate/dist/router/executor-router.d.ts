import type { CredentialConfig, ExecutionResult } from "./types.js";
export declare class ExecutorRouter {
    private sdkExecutor;
    private terraformExecutor;
    execute(capabilityId: string, executor: string, params: Record<string, any>, credentials: CredentialConfig, correlationId: string, toolOverride?: string): Promise<ExecutionResult>;
    /** MCP 路径：直接 spawn MCP Server 子进程，通过 stdio JSON-RPC 通信 */
    private executeMCP;
    /** 根据 capabilityId 找到对应的 MCP Server */
    private resolveMCPServer;
    /** 通过 stdio 调用 MCP Server */
    private callMCPServer;
    /** KooCLI 路径：子进程执行 */
    private executeKooCLI;
    /** 脱敏 — 把 AK/SK 替换为 REDACTED */
    private redact;
    /** 错误分类 */
    private classifyError;
    /** 健康检查 */
    healthCheck(): Promise<Record<string, {
        status: string;
        message?: string;
    }>>;
    /** 探测单个 MCP Server：spawn → initialize → 验证响应 */
    private probeMCPServer;
}
