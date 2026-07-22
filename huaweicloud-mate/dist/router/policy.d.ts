interface PlanToken {
    token: string;
    issuedAt: number;
    ttlMs: number;
    capabilityId: string;
    executor: string;
    params: Record<string, any>;
    risk: string;
}
export declare class PolicyEngine {
    private activeTokens;
    evaluate(capabilityId: string, executor: string, params: Record<string, any>): Promise<{
        approved: boolean;
        plan_token?: string;
        risk_level: string;
        requires_confirmation: boolean;
        cost_estimate?: string;
        executor_locked: boolean;
    }>;
    /** 简单风险推断：根据 executor 和参数中的动词判断 */
    private inferRisk;
    issuePlanToken(capabilityId: string, executor: string, params: Record<string, any>, risk: string): string;
    verifyAndConsume(token: string): PlanToken | null;
}
export {};
