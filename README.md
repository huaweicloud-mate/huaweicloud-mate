# @hd_vector/huaweicloud-meta

华为云 Agent 插件的首版代码骨架。它以本地 stdio MCP 网关向 OpenCode、Claude Code 和 Codex 提供一致的华为云能力入口。

## 当前范围

- 固定暴露 `huaweicloud_discover`、`huaweicloud_provision`、`huaweicloud_call` 三个 MCP 工具，避免一次性向 Agent 注入全量服务 schema。
- 已提供 KooCLI fallback：以非 shell 的结构化命令调用其他华为云服务，并强制二次确认。
- 已预留 ECS、OBS 的 OpenAPI 服务模块和动态 catalog 接入点。
- ECS、OBS 的完整 OpenAPI catalog、签名适配和正式产品 MCP 尚未实现；本仓库不会将其误标为已支持。
- 自动安装仅支持 Windows。

## 安装

```powershell
npx -y @hd_vector/huaweicloud-meta install --agent codex
```

将 `codex` 改为 `claude-code` 或 `opencode` 可得到对应配置。安装器把 KooCLI 安装到当前用户目录，并输出 Agent 的 MCP 配置命令或 JSON。AK/SK 不由本插件处理；请在用户可见的终端中运行：

```powershell
hcloud configure init
```

KooCLI 将交互收集 AK、SK 和默认 Region。不要在项目文件、Agent 配置、日志或命令行参数中保存密钥。

## Agent 配置

三种 Agent 使用同一个 MCP server：

```powershell
npx -y @hd_vector/huaweicloud-meta
```

- Codex：`codex mcp add huaweicloud-mate -- npx -y @hd_vector/huaweicloud-meta`
- Claude Code：`claude mcp add --transport stdio --scope user huaweicloud-mate -- npx -y @hd_vector/huaweicloud-meta`
- OpenCode：在 `opencode.json` 添加 `{ "mcp": { "huaweicloud-mate": { "type": "local", "command": ["npx", "-y", "@hd_vector/huaweicloud-meta"] } } }`。

## 安全调用流程

1. 调用 `huaweicloud_discover` 查询服务。
2. 调用 `huaweicloud_provision` 获取该服务的操作目录。
3. 调用 `huaweicloud_call`。
4. 对有副作用的调用，网关先返回五分钟有效的 `confirmationToken`；Agent 必须在用户明确确认后原样携带令牌再次调用。

更详细的 Agent 行为规范见 [agent.md](agent.md)。
