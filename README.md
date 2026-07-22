# 华为云 Agent Demo (huaweicloud-agent-demo)

> 版本: Demo

基于 OpenCode Server + huaweicloud-mate 的云端 Agent，通过 MCP 协议对外暴露单一工具 `huaweicloud_invoke`，使用自然语言操作华为云资源。

## 项目结构

```
huaweicloud-agent-demo/
├── README.md                              # 本文档
├── mcp-bridge/                            # MCP 桥接层 (对外入口)
│   ├── package.json                       # 依赖: tsx
│   └── server.ts                          # MCP Bridge 主程序
├── huaweicloud-mate/                      # 华为云操作引擎 (npm 包)
│   ├── package.json                       # 包名: huaweicloud-mate, 入口: dist/router/index.js
│   ├── tsconfig.json                      # TypeScript 编译配置
│   ├── data/
│   │   └── capability_index.json          # 15,475 华为云能力索引
│   ├── skills/
│   │   └── general_skill.md               # 通用华为云操作策略
│   └── src/router/
│       ├── index.ts                       # MCP 服务入口，注册 5 个内部工具
│       ├── catalog.ts                     # 能力目录：搜索、获取能力详情
│       ├── credential.ts                  # 凭证代理：从 ~/.hcloud/credentials 读取 AK/SK
│       ├── policy.ts                      # 策略引擎：风险分级 (read/write/cost/destructive)
│       ├── executor-router.ts             # 执行器路由：选择 KooCLI/MCP/SDK/Terraform
│       ├── executor-sdk.ts                # SDK 执行器 (未部署)
│       ├── executor-terraform.ts          # Terraform 执行器 (未部署)
│       ├── koocli-installer.ts           # KooCLI 自动安装器
│       ├── audit.ts                       # 审计日志 (JSONL)
│       └── types.ts                       # 类型定义
└── opencode-config/                       # OpenCode Server 配置
    └── skills/
        └── hw-agent-rules/
            └── SKILL.md                   # Agent 操作规则 (区域确认、安全门控)
```

## 文件详解

### mcp-bridge/server.ts

MCP Bridge 是对外唯一入口，监听 `0.0.0.0:3001`，负责：

1. **MCP 协议处理** — 标准 MCP over HTTP，接收 `initialize` / `tools/list` / `tools/call`
2. **工具注册** — 只暴露一个工具 `huaweicloud_invoke(intent: string)`
3. **会话管理** — 每次 `huaweicloud_invoke` 调用创建独立 session，调用 OpenCode Server 的 `/session` 和 `/session/{id}/message` API
4. **反向代理** — 非 MCP 请求转发到 OpenCode Server (`127.0.0.1:3005`)

启动命令：
```bash
npx tsx server.ts
```

### huaweicloud-mate/src/router/index.ts

内部 MCP Server 入口，通过 stdio 与 OpenCode Server 通信。注册 5 个内部工具：

| 工具 | 作用 |
|------|------|
| `cloud_capability_search` | 搜索华为云能力 (自然语言 → capabilityId) |
| `cloud_capability_describe` | 获取能力详情 (参数 schema、执行器选项) |
| `cloud_targets_status` | 健康检查 (凭证状态、执行器可用性) |
| `cloud_action_plan` | 生成执行计划 (写操作前的安全审查) |
| `cloud_action_execute` | 执行操作 (KooCLI/MCP/SDK/Terraform) |

### huaweicloud-mate/src/router/catalog.ts

能力目录，从 `data/capability_index.json` 加载 15,475 条华为云 API 能力索引。
- `search(query)` — 模糊搜索匹配能力
- `get(capabilityId)` — 获取单个能力的完整信息

### huaweicloud-mate/src/router/credential.ts

凭证代理。加载顺序：
1. 环境变量 `HW_ACCESS_KEY` / `HW_SECRET_KEY`
2. 文件 `~/.hcloud/credentials` (INI 格式，`[default]` section)
3. 都缺失则报错

### huaweicloud-mate/src/router/policy.ts

策略引擎，对每个能力标注风险级别：
- `read` — 直接执行
- `write` — 建议确认
- `cost` / `destructive` — 必须生成 plan 供用户确认

### huaweicloud-mate/src/router/executor-router.ts

根据能力定义和可用性选择执行通道：
1. SDK (最快，需安装 SDK 包)
2. MCP (通过 Mock Server 或 MCP 通道)
3. KooCLI (通过 hcloud CLI)
4. Terraform (编排场景)

### huaweicloud-mate/data/capability_index.json

从 KooCLI 自动发现的 15,475 条华为云能力索引。每条包含：
- `capabilityId` — 如 `huaweicloud.ecs.server.list.v1`
- `product` / `resource` / `action` — 产品/资源/操作
- `risk` — 风险级别
- `executors` — 可用执行器及参数

### opencode-config/skills/hw-agent-rules/SKILL.md

OpenCode Server 加载的 Skill，定义 Agent 操作规则：
1. **区域必确认** — 未指定区域时必须询问用户
2. **执行器选择** — 查询优先 MCP，批量走 KooCLI
3. **安全门控** — 按风险级别分级管控
4. **凭证安全** — AK/SK 绝不暴露在输出中

---

## 架构数据流

```
用户 (OpenCode/Codex)
  │  huaweicloud_invoke(intent="查cn-south-1的ECS")
  ▼
MCP Bridge (:3001) ── server.ts
  │  ① 创建 session → POST :3005/session
  │  ② 发送 message  → POST :3005/session/{id}/message
  ▼
OpenCode Server (:3005) ── opencode serve
  │  🧠 DeepSeek V4 Pro 推理
  │  ③ 加载 hw-agent-rules Skill
  │  ④ 调用 mate-npx 内部工具
  ▼
huaweicloud-mate (stdio MCP)
  │  ⑤ cloud_capability_search → 匹配能力
  │  ⑥ cloud_capability_describe → 获取参数
  │  ⑦ cloud_action_execute → KooCLI/hcloud
  ▼
华为云 API
  │  返回 ECS 实例列表
  └──→ ⑧ 文本结果 → Bridge → 用户
```

---

## 部署到其他 ECS

### 前置条件

| 条件 | 说明 |
|------|------|
| Node.js >= 18 | 运行 Bridge 和 OpenCode Server |
| npm (含 npx) | 安装依赖和运行 tsx |
| OpenCode CLI | `opencode serve` 启动 Server |
| DeepSeek API Key | 配置在 OpenCode Server 中 |
| 华为云 AK/SK | 环境变量 `HW_ACCESS_KEY` / `HW_SECRET_KEY` |
| hcloud CLI | KooCLI 执行器需要 |

### 部署步骤

```bash
# 1. 安装 OpenCode
npm install -g @opencode-ai/opencode

# 2. 部署 huaweicloud-mate (npm 发布方式)
cd huaweicloud-mate
npm install && npm run build
npm publish  # 或 npm link

# 3. 启动 OpenCode Server
export HW_ACCESS_KEY="<AK>"
export HW_SECRET_KEY="<SK>"
opencode serve --port 3005 --hostname 127.0.0.1 &

# 4. 注册 huaweicloud-mate 为 MCP 插件
curl -X POST http://127.0.0.1:3005/mcp \
  -H "Content-Type: application/json" \
  -d '{"name":"mate-npx","config":{"type":"local","command":["npx","-y","huaweicloud-mate"],"enabled":true}}'

# 5. 安装 Agent 规则 Skill
cp opencode-config/skills/hw-agent-rules/SKILL.md \
   ~/.config/opencode/skills/hw-agent-rules/SKILL.md

# 6. 启动 MCP Bridge
cd mcp-bridge
npm install
nohup npx tsx server.ts > /tmp/bridge.log 2>&1 &
```

### 配置 OpenCode Server

在 OpenCode Server 的 `opencode.jsonc` 中：
```jsonc
{
  "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
  "instructions": ["~/.config/opencode/skills/hw-agent-rules/SKILL.md"]
}
```

### 客户端 MCP 配置

任意 MCP 客户端 (OpenCode / Codex / Claude Desktop)：
```json
{
  "mcp": {
    "huaweicloud-agent": {
      "type": "remote",
      "url": "http://<ECS_IP>:3001/mcp",
      "timeout": 300000
    }
  }
}
```

### 可移植性分析

| 组件 | 硬编码依赖 | 可移植性 | 说明 |
|------|-----------|:---:|------|
| mcp-bridge/server.ts | `BACKEND` 环境变量 | ✅ | 默认 `http://127.0.0.1:3005`，可通过环境变量覆盖 |
| huaweicloud-mate | 华为云 API 端点 | ✅ | 所有 API 端点通过 KooCLI 动态解析 |
| credential.ts | `~/.hcloud/credentials` | ✅ | 路径基于 `$HOME`，任意机器有效 |
| capability_index.json | 产品/能力映射 | ✅ | 从 KooCLI 自动生成，与区域/账号无关 |
| hw-agent-rules/SKILL.md | 通用规则 | ✅ | 纯策略文件，无机器相关配置 |
| 凭证 | AK/SK | ✅ | 与账号绑定，非机器绑定；换账号仅需更新 env vars |

**结论：代码与 `113.44.143.91` 这台 ECS 无任何硬绑定。** 只需满足前置条件（Node.js、OpenCode CLI、DeepSeek Key、华为云 AK/SK），即可部署到任意 ECS 或其他云主机上生效。

当前唯一与账号强相关的配置是 IAM 权限——用户 `open_test_01` 仅在 `cn-south-1` 有 ECS 读权限，`cn-north-4` 需额外授权。
