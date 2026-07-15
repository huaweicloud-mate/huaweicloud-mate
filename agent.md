# 华为云 Agent 插件规范

## 使用范围

`huaweicloud-mate` 是一个本地 stdio MCP gateway。首版面向 Windows，兼容 OpenCode、Claude Code 与 Codex。

## 安装与凭证

1. Agent 需要安装时，可执行 `npx -y @hd_vector/huaweicloud-meta install --agent <codex|claude-code|opencode> --configure-openapi`。
2. 安装器自动下载 KooCLI，并输出当前 Agent 的 MCP 配置命令或配置内容。`--configure-openapi` 会在用户可见终端交互采集 ECS/OBS 所需凭证，并用 Windows DPAPI 为当前 Windows 用户加密保存；用户同意后，Agent 可额外使用 `--configure-koocli` 打开 KooCLI 的交互配置。
3. KooCLI fallback 的 AK/SK 与默认 Region 必须由用户在可见终端执行 `hcloud configure init` 时输入；不得要求用户把 AK/SK 贴到对话、项目配置、命令行参数或日志中。
4. 不读取、复制或展示 KooCLI 的加密本地凭证文件。需修改 ECS/OBS 凭证时，指引用户运行 `npx -y @hd_vector/huaweicloud-meta configure`；需删除时运行 `clear-credentials`。显式 MCP 进程环境变量仅作临时覆盖，且这些值不得持久化到项目或 Agent 配置。

## MCP 工作流

1. 始终先调用 `huaweicloud_discover`，再按需调用 `huaweicloud_provision`。
2. 仅调用 provision 返回的可用操作；不要猜测未注册的 ECS/OBS API。
3. 使用 `huaweicloud_call` 发起资源操作。
4. 收到 `confirmation_required` 时，向用户清楚说明资源、区域、动作和可能影响，获得明确确认后，使用同一 service、operation、input 和返回的 `confirmationToken` 重试。

## 强制安全规则

- 不可将创建、删除、修改、启停或 KooCLI 通用命令视作只读。
- 没有当前操作的明确用户确认，不能使用确认令牌执行操作。
- KooCLI 的 `command` 必须是结构化字符串数组，不能拼接 shell 字符串。
- 禁止把 `--cli-access-key`、`--cli-secret-key`、`--cli-security-token` 放入 KooCLI 参数。
- 结果中若出现潜在敏感信息，先脱敏再展示。

## 当前实现边界

- 主 MCP 路由层只管理 ECS、OBS 两个按需加载的子 MCP；KooCLI 是共享 fallback 执行器，不是第三个业务子 MCP。
- 对两个子 MCP 暂未覆盖的产品，可调用主工具的 `service: "koocli"`、`operation: "run"`；必须将命令拆为字符串数组，禁止传入 AK/SK 参数，且必须等待用户二次确认。
- 对 ECS/OBS 的已知但尚未强类型化的 API，可使用对应子 MCP 的 `openapi_request`。必须先根据 API Explorer 填写请求方法和参数；只允许对应服务域名，`GET`/`HEAD` 以外的方法必须等待用户二次确认。优先使用强类型 operation，避免把整个 API 定义加载到 Agent 上下文。
- ECS 已提供 `list_availability_zones`、`list_flavors`、`list_servers`、`get_server`、`get_job` 与受二次确认保护的 `start_servers`、`stop_servers`、`reboot_servers`、`delete_servers`；OBS 已提供 `list_buckets`、`get_bucket_metadata`、`get_bucket_location`、`list_objects`、`get_object_metadata`、最多读取 1 MiB 的 `get_object`，以及受二次确认保护的 `create_bucket`、`put_object`、`copy_object`、`append_object`、`delete_object`、`delete_bucket`。完整 OpenAPI catalog 仍未导入，不能声称已覆盖 API 全量。
- 后续产品部提供正式 MCP 时，应以相同服务 id 替换对应 adapter，而不改变 Agent 的 discover/provision/call 调用方式。

## 首版正式发布验收目标

在以下条件全部满足前，不得宣称首版已经正式发布，或已完成 OpenCode、Claude Code、Codex 与全量 ECS/OBS OpenAPI 的验收：

1. ECS、OBS API Explorer 的全量 operation catalog 已导入；每个 operation 具备独立输入 schema、来源链接和调用验证。`openapi_request` 仅是过渡性受控入口，不能替代全量逐接口 catalog 验收。
2. 使用非生产测试账号完成 ECS、OBS 的真实只读调用与受二次确认保护的写操作验证；不得在对话中索取或展示 AK/SK。
3. 在干净的 Windows 环境中，从目标 npm registry 完成 `npx` 安装、KooCLI 安装与凭证配置验证。
4. 在 OpenCode、Claude Code、Codex 中分别完成真实 MCP 安装、discover/provision/call 调用与写操作确认流程验证。
