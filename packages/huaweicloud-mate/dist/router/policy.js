"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolicyEngine = void 0;
const DEFAULT_TTL = {
    read: 120_000, // 2min
    write: 60_000, // 1min
    cost: 60_000, // 1min
    destructive: 30000, // 30s
    privileged: 15000, // 15s
};
class PolicyEngine {
    activeTokens = new Map();
    async evaluate(capabilityId, executor, params) {
        const risk = this.inferRisk(params, executor);
        const requiresConfirmation = ["cost", "destructive", "privileged"].includes(risk);
        if (["destructive", "privileged"].includes(risk) && !params.region) {
            return {
                approved: false,
                risk_level: risk,
                requires_confirmation: true,
                executor_locked: true,
            };
        }
        if (!requiresConfirmation) {
            return {
                approved: true,
                risk_level: risk,
                requires_confirmation: false,
                executor_locked: false,
            };
        }
        const token = this.issuePlanToken(capabilityId, executor, params, risk);
        return {
            approved: true,
            plan_token: token,
            risk_level: risk,
            requires_confirmation: true,
            executor_locked: true,
        };
    }
    /** 简单风险推断：根据 executor 和参数中的动词判断 */
    inferRisk(params, executor) {
        const action = (params.action || params.operation || "").toLowerCase();
        if (/delete|terminate|release|destroy/.test(action))
            return "destructive";
        if (/iam|permission|policy|role/.test(action))
            return "privileged";
        if (/create|resize|expand/.test(action))
            return "cost";
        if (/update|modify|restart|stop|start/.test(action))
            return "write";
        return "read";
    }
    issuePlanToken(capabilityId, executor, params, risk) {
        const token = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ttlMs = DEFAULT_TTL[risk] || 60_000;
        this.activeTokens.set(token, {
            token,
            issuedAt: Date.now(),
            ttlMs,
            capabilityId,
            executor,
            params,
            risk,
        });
        return token;
    }
    verifyAndConsume(token) {
        const plan = this.activeTokens.get(token);
        if (!plan)
            return null;
        if (Date.now() - plan.issuedAt > plan.ttlMs) {
            this.activeTokens.delete(token);
            return null;
        }
        this.activeTokens.delete(token); // 一次性消费
        return plan;
    }
}
exports.PolicyEngine = PolicyEngine;
