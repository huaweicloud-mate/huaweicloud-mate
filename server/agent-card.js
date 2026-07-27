// cloud-server/agent-card.js — 云端 Agent 能力声明 (A2A AgentCard)
// 符合 Google A2A 协议规范

export function getAgentCard() {
  return {
    name: "Huawei Cloud Agent",
    description:
      "部署在华为云上的全能运维 Agent。可自主调用 koocli、MCP 工具链、华为云 API，完成基础设施管理、应用部署、监控运维等任务。",
    url: process.env.AGENT_URL || "https://agent.example.com",
    provider: {
      organization: "Codex User",
      url: process.env.AGENT_URL || "https://agent.example.com",
    },
    version: "2.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "compute",
        name: "计算服务管理",
        description: "通过 koocli 管理 ECS 云服务器：创建、启动、停止、销毁、扩容、镜像管理",
        tags: ["ecs", "koocli", "compute"],
        examples: ["创建一台 4C8G 的 ECS", "给所有 ECS 打标签"],
      },
      {
        id: "network",
        name: "网络服务管理",
        description: "管理 VPC、子网、安全组、EIP、负载均衡",
        tags: ["vpc", "eip", "security-group", "network"],
        examples: ["创建一个带安全组的 VPC", "给 ECS 绑定公网 IP"],
      },
      {
        id: "storage",
        name: "存储服务管理",
        description: "管理 OBS 对象存储、EVS 云硬盘、SFS 文件存储",
        tags: ["obs", "evs", "storage"],
        examples: ["创建 OBS 桶并设置生命周期策略", "给 ECS 挂载数据盘"],
      },
      {
        id: "deploy",
        name: "应用部署",
        description: "部署应用（Spring Boot、Node.js、Docker 等），配置 CCE 容器集群",
        tags: ["deploy", "spring-boot", "docker", "cce"],
        examples: ["部署 Spring Boot 应用到 ECS", "在 CCE 上部署微服务"],
      },
      {
        id: "monitor",
        name: "监控与告警",
        description: "配置 Cloud Eye 监控、告警规则，查看资源使用情况",
        tags: ["monitor", "alarm", "cloud-eye"],
        examples: ["给 ECS 配置 CPU 超过 80% 告警"],
      },
      {
        id: "database",
        name: "数据库管理",
        description: "管理 RDS、GaussDB、DDS 等数据库实例",
        tags: ["rds", "database", "gaussdb"],
        examples: ["创建 RDS MySQL 实例", "配置数据库备份策略"],
      },
      {
        id: "iam",
        name: "权限管理",
        description: "管理 IAM 用户、角色、策略",
        tags: ["iam", "permission", "policy"],
        examples: ["创建一个只读权限的 IAM 用户"],
      },
      {
        id: "coding",
        name: "通用编码",
        description: "通过 OpenCode CLI 执行代码生成、重构、文件操作等任务",
        tags: ["code", "opencode", "refactor"],
        examples: ["生成 Docker Compose 配置", "写一个监控脚本"],
      },
    ],
    // 云端 Agent 内部使用的工具链
    toolChain: {
      primary: "koocli",                     // 华为云命令行工具
      mcpServices: ["huawei-ecs", "huawei-obs", "huawei-vpc", "huawei-rds"],
      skills: ["deploy-spring-boot", "docker-compose", "nginx-config"],
      agent: "opencode",                     // OpenCode CLI 作为底层推理引擎
    },
    // 支持的任务类型
    supportedTaskTypes: [
      "deploy-application",
      "create-infrastructure",
      "manage-resources",
      "troubleshoot",
      "code-generation",
      "batch-operations",
    ],
  };
}
