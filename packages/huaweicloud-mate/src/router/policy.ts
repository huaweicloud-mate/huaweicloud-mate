/**
 * PolicyEngine — 策略引擎
 *
 * 首版：风险分级 + plan_token 管理（内存 Map）
 * 二期：持久化 + 审批工作流 + MFA
 */
import type { CapabilityEntry } from "./types.js";

interface PlanToken {
  token: string;
  issuedAt: number;
  ttlMs: number;
  capabilityId: string;
  executor: string;
  params: Record<string, any>;
  risk: string;
}

const DEFAULT_TTL = {
  read: 120_000,        // 2min
  write: 60_000,        // 1min
  cost: 60_000,         // 1min
  destructive: 30000,   // 30s
  privileged: 15000,    // 15s
};

export class PolicyEngine {
  private activeTokens = new Map<string, PlanToken>();

  async evaluate(
    capabilityId: string,
    executor: string,
    params: Record<string, any>
  ): Promise<{
    approved: boolean;
    plan_token?: string;
    risk_level: string;
    requires_confirmation: boolean;
    cost_estimate?: string;
    executor_locked: boolean;
  }> {
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
  private inferRisk(params: Record<string, any>, executor: string): string {
    const action = (params.action || params.operation || "").toLowerCase();
    if (/delete|terminate|release|destroy/.test(action)) return "destructive";
    if (/iam|permission|policy|role/.test(action)) return "privileged";
    if (/create|resize|expand/.test(action)) return "cost";
    if (/update|modify|restart|stop|start/.test(action)) return "write";
    return "read";
  }

  issuePlanToken(
    capabilityId: string,
    executor: string,
    params: Record<string, any>,
    risk: string
  ): string {
    const token = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ttlMs = DEFAULT_TTL[risk as keyof typeof DEFAULT_TTL] || 60_000;

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

  verifyAndConsume(token: string): PlanToken | null {
    const plan = this.activeTokens.get(token);
    if (!plan) return null;
    if (Date.now() - plan.issuedAt > plan.ttlMs) {
      this.activeTokens.delete(token);
      return null;
    }
    this.activeTokens.delete(token); // 一次性消费
    return plan;
  }
}
