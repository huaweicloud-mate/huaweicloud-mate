# Huawei Cloud Agent — POC

> 版本: v2.0 (POC)
> 部署: 华为云 CCE + K8s Job

云端 Agent 工具。用户请求时按需拉起 K8s Job，Job 内运行 OpenCode + huaweicloud-mate + hcloud CLI。支持 A2A 和 MCP 双协议接入。

## 项目结构

```
huaweicloud-agent-demo/
│
├── cloud-server/                           # A2A Server (:3000)
│   ├── server.js                           # Express — A2A + MCP 双协议入口
│   ├── auth.js                             # AK/SK SigV4 验签 + userId 提取
│   ├── task-manager.js                     # 任务状态机 + SSE 流式推送
│   ├── sandbox.js                          # K8s Job 编排 (per-user)
│   ├── mcp-routes.js                       # MCP 协议处理 (huaweicloud_invoke)
│   ├── agent-card.js                       # AgentCard 能力声明
│   ├── Dockerfile.server                   # A2A Server 镜像
│   ├── Dockerfile.sandbox                  # 沙箱镜像 (opencode + mate + hcloud + skills)
│   ├── entrypoint.sh                       # 沙箱启动脚本
│   ├── docker-compose.yml                  # 本地开发
│   ├── k8s/                                # CCE 部署清单
│   │   ├── deployment.yaml / service.yaml / ingress.yaml
│   │   ├── configmap.yaml / rbac.yaml
│   └── terraform/                          # 基础设施即代码
│       ├── main.tf / variables.tf / outputs.tf
│
├── huaweicloud-mate/                       # Agent 引擎 (npm 包 v0.0.5)
│   ├── src/router/
│   │   ├── index.ts                        # 6 个 MCP 工具 (含 cloud_skill_search)
│   │   ├── skill-search.ts                 # Skill 匹配 + 加载
│   │   └── catalog / credential / policy / executor / audit
│   └── data/capability_index.json          # 15,475 能力索引
│
├── mcp-bridge/                             # 参考代码 (不部署)
│   └── server.ts
│
├── scripts/                                # Codex Plugin 本地客户端
│   ├── server.js                           # MCP stdio Server (A2A Client)
│   ├── setup.js / setup-mcp.js             # 配置向导
│   ├── crypto.js                           # AES-256-GCM 凭证加密
│   └── huawei-client.js                    # SigV4 签名
│
├── opencode-config/skills/hw-agent-rules/  # Agent 元规则
│   └── SKILL.md
│
└── huaweicloud-skills/                     # 65 个华为云 Skills (git submodule)
```

## 架构

```
用户 (Codex/OpenCode/Claude)
  │ A2A: delegate_task / MCP: huaweicloud_invoke
  ▼
A2A Server (:3000)
  │ SigV4 验签 → createNamespacedJob
  ▼
K8s Job: sandbox-{userId} (ttl: 30min, 1C1G/2C2G)
  │ opencode serve :3005 + huaweicloud-mate
  │ SSE progress → completed → Job 清理
  ▼
华为云 API
```

## 快速开始

### 本地开发

```bash
cd cloud-server
cp .env.example .env
docker compose up -d
curl http://localhost:3000/api/v1/health
```

### 部署到 CCE

```bash
# 1. 构建镜像（版本号 YYYYMMDDHHmmss）
VERSION=$(date +%Y%m%d%H%M%S)
docker build -t server:${VERSION} -f cloud-server/Dockerfile.server .
docker build -t sandbox:${VERSION} -f cloud-server/Dockerfile.sandbox .
docker tag server:${VERSION} swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/server:${VERSION}
docker tag server:${VERSION} swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/server:latest
docker tag sandbox:${VERSION} swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/sandbox:${VERSION}
docker tag sandbox:${VERSION} swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/sandbox:latest
docker push swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/server:${VERSION}
docker push swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/server:latest
docker push swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/sandbox:${VERSION}
docker push swr.cn-north-4.myhuaweicloud.com/huaweicloud-agent/sandbox:latest

# 2. 基础设施 (Terraform)
cd cloud-server/terraform && terraform init && terraform apply

# 3. K8s 部署
kubectl create namespace huaweicloud-agent
kubectl apply -f cloud-server/k8s/
```

## 客户端接入

**Codex Plugin:**
```bash
cd scripts && node setup.js
```

**OpenCode (MCP):**
```bash
cd scripts && node setup-mcp.js
# 将输出的 JSON 写入 opencode.json
```

## 架构文档

`docs/superpowers/specs/2026-07-21-huaweicloud-agent-docker-poc-design.md`
