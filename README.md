# @hd_vector/huaweicloud-meta

华为云 Agent 插件首版。它以本地 stdio MCP 网关向 OpenCode、Claude Code 和 Codex 提供一致的华为云能力入口。

## 当前范围

- 固定暴露 `huaweicloud_discover`、`huaweicloud_provision`、`huaweicloud_call` 三个主 MCP 工具；主路由只发现和按需加载两个子 MCP：ECS、OBS，避免一次性向 Agent 注入全量服务 schema。
- 已提供 KooCLI 共享 fallback：以非 shell 的结构化命令调用其他华为云服务，并强制二次确认；它不是第三个业务子 MCP。
- ECS/OBS 使用各自的官方 AK/SK 签名方式；高频 ECS/OBS 操作保留为便捷入口，并由完整动态 catalog 补齐其余接口。
- 两个子 MCP 都提供受控 `openapi_request`：用于调用强类型目录之外的 ECS/OBS API Explorer 接口。请求始终固定到对应服务域名；响应限制为最多 1 MiB；`GET`、`HEAD`、`OPTIONS` 视为只读，其余 HTTP 方法均须二次确认。优先使用已列出的强类型操作。
- 每个 ECS/OBS catalog 操作均携带其对应的 API Explorer 来源链接；新操作应以 `https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=<operation>` 或 OBS 同格式页面为准。
- ECS 99 项、OBS 81 项 operation catalog 已由锁定版本的官方 Node.js SDK 自动生成，并随服务 provision 按需加载；每项携带 API Explorer 来源链接、独立入口 schema 与 method 驱动的确认策略。回归会以 mock transport 验证全部 180 个生成 operation 的路径、签名和写操作确认；尚未完成真实账号逐接口验收，因此不得宣称“全量 OpenAPI 已验收”。
- 自动安装仅支持 Windows。

## 让 Agent 协助安装

当前仓库仍处于私有开发验证阶段，用户的 Agent 无法读取公开安装指南。因此现在把下面这段话原样发给你正在使用的 Agent；用户无需说明或选择 Agent 类型：

```text
请为当前环境安装并配置华为云 Agent 插件。执行 `npx -y @hd_vector/huaweicloud-meta install --agent auto --configure-openapi --configure-koocli`，并完成验证。
不要要求我在聊天中发送 AK/SK；需要凭证、默认 Region 或 Project ID 时，请在用户可见的安全交互终端中向我索取。
如发现旧的 huaweicloud-mate MCP 配置，请说明差异并让我选择更新或保留。完成后告诉我是否需要重启或新开会话。
```

安装器会通过当前运行环境自动选择适配器；若无法识别，当前 Agent 应自行识别其宿主并使用内部兼容参数重试，不能要求用户判断 Agent 类型。新增其他 Agent 时只需增加内部适配器，以上提示词保持不变。

开源发布后，此处将切换为更短的提示词：`请阅读并严格执行华为云 Agent 插件安装指南：<PUBLIC_AGENT_INSTALL_GUIDE_URL>`。发布前替换该 URL 并验证匿名可访问；详细切换清单见 [agent-install.md](agent-install.md)。

## 安装

在项目目录的 PowerShell 中执行下列对应命令。三者都会安装 KooCLI、配置 ECS/OBS 的本地加密凭证，并自动合并 MCP 配置。通常应优先使用上面的 Agent 协助安装入口：

```powershell
# OpenCode：写入 ~/.config/opencode/opencode.json（或 OPENCODE_CONFIG 指定文件）
npx -y @hd_vector/huaweicloud-meta install --agent opencode --configure-openapi --configure-koocli

# Claude Code：写入 ~/.claude.json
npx -y @hd_vector/huaweicloud-meta install --agent claude-code --configure-openapi --configure-koocli

# Codex Desktop / CLI：写入当前项目的 .codex/config.toml
npx -y @hd_vector/huaweicloud-meta install --agent codex --configure-openapi --configure-koocli
```

安装器不会把 AK/SK 写入 Agent 配置。`--configure-openapi` 会交互收集 AK、SK、默认 Region 和可选 Project ID，并以 Windows 当前用户的 DPAPI 加密保存，供 ECS/OBS 子 MCP 使用。`--configure-koocli` 会立即启动 KooCLI 的交互配置；如暂不需要 KooCLI fallback，可移除该参数，之后也能在用户可见的终端中运行：

```powershell
hcloud configure init
```

KooCLI 将交互收集 AK、SK 和默认 Region，并加密保存在其本地 profile 中；它供 KooCLI fallback 使用。KooCLI profile 与 ECS/OBS 的 DPAPI 本地凭证存储彼此独立，插件不会读取或解密 KooCLI profile。

需要修改账号、Region 或 Project ID 时，重新运行 `npx -y @hd_vector/huaweicloud-meta configure`，它会安全覆盖旧值；需要删除时运行 `npx -y @hd_vector/huaweicloud-meta clear-credentials`。显式设置的 `HUAWEICLOUD_AK`、`HUAWEICLOUD_SK`、`HUAWEICLOUD_REGION` 和 `HUAWEICLOUD_PROJECT_ID` 只对当前 MCP 进程生效，并优先于本地加密存储，适合临时切换账号。不要把密钥放入项目文件、Agent 配置、日志或命令行参数。

## Agent 配置

三种 Agent 使用同一个 MCP server。安装器默认会自动合并配置；如果发现同名的旧配置，会询问是否更新，选择保留不会影响其他 MCP。非交互终端默认保留旧配置，可传入 `--force-agent-config` 强制更新，或用 `--skip-agent-config` 跳过 Agent 配置。

- Codex Desktop/CLI：当前项目 `.codex/config.toml` 的 `huaweicloud_mate` MCP 段。
- Claude Code：当前用户 `~/.claude.json` 的 `mcpServers.huaweicloud-mate`。
- OpenCode：当前用户 `~/.config/opencode/opencode.json` 的 `mcp.huaweicloud-mate`。

### Codex Desktop

安装命令使用 `--agent codex` 时会自动创建或更新项目根目录的 `.codex/config.toml`：

```toml
[mcp_servers.huaweicloud_mate]
command = "npx"
args = ["-y", "@hd_vector/huaweicloud-meta"]
enabled = true
startup_timeout_sec = 15
```

重新打开该项目或新建 Codex 任务后，Desktop 才会加载新 MCP 配置。仓库内自带的 `.codex/config.toml` 是开发配置，使用 `node build/server.js` 启动当前工作区的代码；它不适用于 npm 用户。

## 安全调用流程

1. 调用 `huaweicloud_discover` 查询两个子 MCP（`ecs`、`obs`）。
2. 调用 `huaweicloud_provision` 按需加载其中一个子 MCP 的操作目录。
3. 调用 `huaweicloud_call`，以子 MCP id 和 operation 调用 OpenAPI。
4. 对有副作用的调用，网关先返回五分钟有效的 `confirmationToken`；Agent 必须在用户明确确认后原样携带令牌再次调用。

对于当前两个子 MCP 未覆盖的服务，可直接通过主工具调用共享 fallback：`service: "koocli"`、`operation: "run"`、`input: { "command": ["<service>", "<operation>", "..."] }`。该路径不会出现在子 MCP 发现列表，且始终要求二次确认。

当需要已知 ECS 或 OBS 接口、但子 MCP 没有强类型 operation 时，使用其 `openapi_request`，并以对应 API Explorer 页面确认 `method`、`path`、`query`、`body` 或 OBS `headers`。ECS `path` 可使用 `{project_id}` 或 `{projectId}` 占位符；OBS 对象内容使用 `contentBase64`，对象 GET 会自动附加受限的 `Range` 请求头。

更详细的 Agent 行为规范见 [agent.md](agent.md)。
