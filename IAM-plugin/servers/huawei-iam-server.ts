/**
 * huawei-iam-server — 华为云 IAM MCP Server
 *
 * 10 个只读 IAM tool，通过 AK/SK 签名认证，调用华为云 IAM REST API。
 *
 * 运行: npx tsx servers/huawei-iam-server.ts
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { signedFetch } from "../src/signer.js";

// ============================================================
// 配置（全部从环境变量读取）
// ============================================================
const IAM_ENDPOINT = process.env.HUAWEI_IAM_ENDPOINT || "https://iam.myhuaweicloud.com";
const AK = process.env.HUAWEI_AK || "";
const SK = process.env.HUAWEI_SK || "";

// ============================================================
// 通用 IAM API 请求（GET，AK/SK 签名）
// ============================================================
let _domainId: string | null = null;

async function ensureDomainId(): Promise<string> {
  if (_domainId) return _domainId;
  // 从 projects 接口自动获取 domain_id
  const res = await signedFetch(AK, SK, "GET", `${IAM_ENDPOINT}/v3/projects`);
  const data: any = await res.json();
  _domainId = data?.projects?.[0]?.domain_id || "";
  if (!_domainId) {
    throw new Error("无法获取华为云账号 domain_id");
  }
  console.error(`[huawei-iam-server] domain_id: ${_domainId}`);
  return _domainId;
}

async function iamGet(path: string): Promise<unknown> {
  if (!AK || !SK) {
    throw new Error(
      "缺少华为云 AK/SK 环境变量: HUAWEI_AK / HUAWEI_SK"
    );
  }

  const domainId = await ensureDomainId();
  const url = `${IAM_ENDPOINT}${path}`;
  const res = await signedFetch(AK, SK, "GET", url, undefined, {
    extraHeaders: { "X-Domain-Id": domainId },
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`IAM API 错误 HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

// ============================================================
// Server
// ============================================================
const server = new McpServer({
  name: "huawei-iam-server",
  version: "0.1.0",
});

// ============================================================
// Tool 1: list_iam_users
// ============================================================
server.registerTool(
  "list_iam_users",
  {
    description:
      "查询华为云 IAM 用户列表。返回所有 IAM 用户的基本信息（用户名、ID、状态、创建时间等）。",
    inputSchema: {
      domain_id: z.string().optional().describe("账号 domain ID（可选）"),
    },
  },
  async () => {
    const result = await iamGet("/v3/users");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 2: get_iam_user
// ============================================================
server.registerTool(
  "get_iam_user",
  {
    description:
      "查询指定 IAM 用户的详细信息，包括邮箱、手机号、描述、所属用户组等。",
    inputSchema: {
      user_id: z.string().describe("IAM 用户 ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/users/${args.user_id}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 3: list_user_groups
// ============================================================
server.registerTool(
  "list_user_groups",
  {
    description:
      "查询华为云 IAM 用户组列表。返回所有用户组的基本信息（名称、ID、描述、创建时间等）。",
    inputSchema: {
      domain_id: z.string().optional().describe("账号 domain ID（可选）"),
    },
  },
  async () => {
    const result = await iamGet("/v3/groups");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 4: get_user_group
// ============================================================
server.registerTool(
  "get_user_group",
  {
    description:
      "查询指定用户组的详细信息，包括名称、描述、创建时间、用户数等。",
    inputSchema: {
      group_id: z.string().describe("用户组 ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/groups/${args.group_id}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 5: list_users_in_group
// ============================================================
server.registerTool(
  "list_users_in_group",
  {
    description: "查询指定用户组中包含的所有 IAM 用户。",
    inputSchema: {
      group_id: z.string().describe("用户组 ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/groups/${args.group_id}/users`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 6: list_user_projects
// ============================================================
server.registerTool(
  "list_user_projects",
  {
    description: "查询指定 IAM 用户可以访问的华为云项目列表。",
    inputSchema: {
      user_id: z.string().describe("IAM 用户 ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/users/${args.user_id}/projects`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 7: list_projects
// ============================================================
server.registerTool(
  "list_projects",
  {
    description:
      "查询华为云账号下所有的项目列表，包括项目名称、ID、状态、创建时间等。",
    inputSchema: {
      domain_id: z.string().optional().describe("账号 domain ID（可选）"),
    },
  },
  async () => {
    const result = await iamGet("/v3/projects");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 8: get_project
// ============================================================
server.registerTool(
  "get_project",
  {
    description:
      "查询指定项目的详细信息，包括名称、ID、状态、创建时间、描述等。",
    inputSchema: {
      project_id: z.string().describe("项目 ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/projects/${args.project_id}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 9: list_roles
// ============================================================
server.registerTool(
  "list_roles",
  {
    description:
      "查询华为云 IAM 权限（角色）列表。返回所有系统预置权限和自定义权限的列表。",
    inputSchema: {
      domain_id: z.string().optional().describe("账号 domain ID（可选）"),
    },
  },
  async () => {
    const result = await iamGet("/v3/roles");
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// Tool 10: get_role
// ============================================================
server.registerTool(
  "get_role",
  {
    description:
      "查询指定权限（角色）的详细信息，包括名称、描述、策略内容等。",
    inputSchema: {
      role_id: z.string().describe("权限（角色）ID"),
    },
  },
  async (args) => {
    const result = await iamGet(`/v3/roles/${args.role_id}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================
// 启动
// ============================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[huawei-iam-server] 已启动，10 个 IAM tool 已注册 (endpoint: ${IAM_ENDPOINT})`
  );
}

main().catch((err) => {
  console.error("[huawei-iam-server] 启动失败:", err);
  process.exit(1);
});