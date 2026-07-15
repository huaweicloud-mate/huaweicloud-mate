# @hd_vector/huaweicloud-meta

华为云 Agent 插件的首版代码骨架。它以本地 stdio MCP 网关向 OpenCode、Claude Code 和 Codex 提供一致的华为云能力入口。

## 当前范围

- 固定暴露 `huaweicloud_discover`、`huaweicloud_provision`、`huaweicloud_call` 三个主 MCP 工具；主路由只发现和按需加载两个子 MCP：ECS、OBS，避免一次性向 Agent 注入全量服务 schema。
- 已提供 KooCLI 共享 fallback：以非 shell 的结构化命令调用其他华为云服务，并强制二次确认；它不是第三个业务子 MCP。
- ECS/OBS 已有独立的官方 AK/SK 签名器与首批动态 catalog 操作：ECS 可用区/规格/查询/单机详情/异步任务/批量启停/重启/删除、OBS 列桶/桶元数据/桶区域/列对象/对象元数据/限量内容读取/受确认保护的桶创建、标准上传、服务端复制、追加写与对象/桶删除。
- 两个子 MCP 都提供受控 `openapi_request`：用于调用强类型目录之外的 ECS/OBS API Explorer 接口。请求始终固定到对应服务域名；响应限制为最多 1 MiB；`GET`/`HEAD` 只读，其余 HTTP 方法均须二次确认。优先使用已列出的强类型操作。
- 每个 ECS/OBS catalog 操作均携带其对应的 API Explorer 来源链接；新操作应以 `https://console.huaweicloud.com/apiexplorer/#/openapi/ECS/doc?api=<operation>` 或 OBS 同格式页面为准。
- ECS、OBS 的完整 OpenAPI catalog 和正式产品 MCP 尚未实现；本仓库不会将当前少量操作误标为全量 API 支持。
- 自动安装仅支持 Windows。

## 安装

```powershell
npx -y @hd_vector/huaweicloud-meta install --agent codex --configure-openapi
```

将 `codex` 改为 `claude-code` 或 `opencode` 可得到对应配置。安装器把 KooCLI 安装到当前用户目录，并输出 Agent 的 MCP 配置命令或 JSON。`--configure-openapi` 会交互收集 AK、SK、默认 Region 和可选 Project ID，并以 Windows 当前用户的 DPAPI 加密保存，供 ECS/OBS 子 MCP 使用。若希望立即进行 KooCLI 交互配置，可额外传入 `--configure-koocli`；也可以在用户可见的终端中运行：

```powershell
hcloud configure init
```

KooCLI 将交互收集 AK、SK 和默认 Region，并加密保存在其本地 profile 中；它供 KooCLI fallback 使用。KooCLI profile 与 ECS/OBS 的 DPAPI 本地凭证存储彼此独立，插件不会读取或解密 KooCLI profile。

需要修改账号、Region 或 Project ID 时，重新运行 `npx -y @hd_vector/huaweicloud-meta configure`，它会安全覆盖旧值；需要删除时运行 `npx -y @hd_vector/huaweicloud-meta clear-credentials`。显式设置的 `HUAWEICLOUD_AK`、`HUAWEICLOUD_SK`、`HUAWEICLOUD_REGION` 和 `HUAWEICLOUD_PROJECT_ID` 只对当前 MCP 进程生效，并优先于本地加密存储，适合临时切换账号。不要把密钥放入项目文件、Agent 配置、日志或命令行参数。

## Agent 配置

三种 Agent 使用同一个 MCP server：

```powershell
npx -y @hd_vector/huaweicloud-meta
```

- Codex：`codex mcp add huaweicloud-mate -- npx -y @hd_vector/huaweicloud-meta`
- Claude Code：`claude mcp add --transport stdio --scope user huaweicloud-mate -- npx -y @hd_vector/huaweicloud-meta`
- OpenCode：在 `opencode.json` 添加 `{ "mcp": { "huaweicloud-mate": { "type": "local", "command": ["npx", "-y", "@hd_vector/huaweicloud-meta"] } } }`。

## 安全调用流程

1. 调用 `huaweicloud_discover` 查询两个子 MCP（`ecs`、`obs`）。
2. 调用 `huaweicloud_provision` 按需加载其中一个子 MCP 的操作目录。
3. 调用 `huaweicloud_call`，以子 MCP id 和 operation 调用 OpenAPI。
4. 对有副作用的调用，网关先返回五分钟有效的 `confirmationToken`；Agent 必须在用户明确确认后原样携带令牌再次调用。

对于当前两个子 MCP 未覆盖的服务，可直接通过主工具调用共享 fallback：`service: "koocli"`、`operation: "run"`、`input: { "command": ["<service>", "<operation>", "..."] }`。该路径不会出现在子 MCP 发现列表，且始终要求二次确认。

当需要已知 ECS 或 OBS 接口、但子 MCP 没有强类型 operation 时，使用其 `openapi_request`，并以对应 API Explorer 页面确认 `method`、`path`、`query`、`body` 或 OBS `headers`。ECS `path` 可使用 `{project_id}` 或 `{projectId}` 占位符；OBS 对象内容使用 `contentBase64`，对象 GET 会自动附加受限的 `Range` 请求头。

更详细的 Agent 行为规范见 [agent.md](agent.md)。
