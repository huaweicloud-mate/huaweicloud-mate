# huaweicloud-mate

华为云 Agent 插件 — Tool Router + MCP + KooCLI + Skills

## 架构

```
Agent (OpenCode / Claude Code / Codex)
  │  MCP stdio JSON-RPC
  ▼
huaweicloud-mate Router (5固定工具)
  ├── cloud_capability_search   → 搜索 15,475 能力 (210 产品)
  ├── cloud_capability_describe → 获取能力详情 + 参数 schema
  ├── cloud_targets_status      → 凭证状态 + 执行器健康
  ├── cloud_action_plan         → 高风险操作生成 plan_token
  └── cloud_action_execute      → 分发到 MCP 或 KooCLI 执行
```

## 安装

```bash
npm install huaweicloud-mate
```

## 配置

```bash
# 凭证文件 (~/.hcloud/credentials)
cat > ~/.hcloud/credentials << 'EOF'
[default]
huaweicloud_access_key = YOUR_AK
huaweicloud_secret_key = YOUR_SK
huaweicloud_region = cn-north-4
EOF
chmod 600 ~/.hcloud/credentials
```

KooCLI 在插件首次启动时自动下载安装（SHA-256 校验）。

## 注册到 Agent

**OpenCode:** `opencode mcp add huaweicloud-mate -- node /path/to/dist/router/index.js`

**Claude Code / Codex:** 在 `mcp.json` 中添加：
```json
{
  "huaweicloud-mate": {
    "command": "node",
    "args": ["/path/to/dist/router/index.js"]
  }
}
```

## 开发

```bash
# 构建
npm run build

# 生成全量能力索引 (从 KooCLI 扫描)
npm run build:catalog

# 端到端测试
bash scripts/e2e-test.sh
```

## 项目结构

```
src/router/index.ts           Router 入口 (5 MCP tools)
src/router/catalog.ts         能力目录 (15,475 条 / 210 产品)
src/router/executor-router.ts MCP + KooCLI 双执行器
src/router/koocli-installer.ts KooCLI 自动安装
src/router/policy.ts          风险分级 + plan_token
src/router/credential.ts      ~/.hcloud/credentials
src/router/audit.ts           JSONL 审计日志
src/mock/ecs-mock-server.ts   Mock MCP Server
data/capability_index.json    能力索引 (npm run build:catalog 生成)
scripts/build-capability-index.py  全量能力扫描脚本
skills/general_skill.md       Agent 操作指南
adapters/                     Claude/Codex/OpenCode 配置模板
```
