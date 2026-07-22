/**
 * Router 共享类型定义
 */

export interface CapabilityEntry {
  capabilityId: string;
  product: string;
  resource: string;
  action: string;
  summary: string;
  risk: { level: "read" | "write" | "cost" | "destructive" | "privileged"; [key: string]: any };
  scope: { account: string; project: string; region: string };
  executors: {
    mcp?: {
      server: string;
      tool: string;
      status: string;
    } | null;
    koocli?: {
      service: string;
      operation: string;
      params: {
        required: string[];
        optional: string[];
        defaults: Record<string, any>;
      };
      status: string;
    } | null;
    sdk?: {
      package: string;
      method: string;
      status: string;
    } | null;
    terraform?: {
      resource: string;
      status: string;
    } | null;
  };
}

export interface CapabilityIndex {
  catalog: Record<string, CapabilityEntry>;
  by_product: Record<string, string[]>;
  by_action: Record<string, string[]>;
  search_index: Record<string, string[]>;
}

export interface RouterTool {
  name: string;
  description: string;
  isRead: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<any>;
}

export interface ExecuteParams {
  planToken?: string;
  capabilityId?: string;
  executor?: string;
  params?: Record<string, any>;
}

export interface CredentialConfig {
  huaweicloud_access_key: string;
  huaweicloud_secret_key: string;
  huaweicloud_region?: string;
}

export interface AuditEntry {
  ts: string;
  correlationId: string;
  capabilityId: string;
  executor: string;
  risk: string;
  result: string;
  duration_ms: number;
  error?: string;
}

export interface ExecutionResult {
  success: boolean;
  data?: any;
  error?: any;
  execution: {
    executor: string;
    correlationId: string;
    duration_ms: number;
  };
}
