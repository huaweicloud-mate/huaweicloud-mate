# ADR-0030：稳定 Router 进程握手作为码道启动证据

状态：Accepted
日期：2026-07-14

## 背景

ADR-0017 已为 Codex、Claude Code 和 OpenCode 绑定宿主原生只读枚举，但华为云码道没有已确认的稳定枚举子命令。仅复核 `codearts_cli.jsonc` 与 Canonical Skill 能证明受管配置正确落盘，不能证明其中绑定的稳定 launcher 确实能启动 Router 并完成 MCP 协议初始化。

不得为了补齐验收而猜测 CodeArts CLI 命令、读取可能含敏感字段的完整 debug 配置，或恢复通用宿主 Adapter SPI。

## 决策

1. 首装提交前，继续保留稳定 launcher 的精确版本烟测，并额外以宿主配置中的同一固定 Node、launcher 和 `router --stdio` 参数启动真实子进程。
2. verifier 直接完成有界的 MCP `initialize`、`notifications/initialized` 和 `tools/list` 握手；不读取凭证、不调用 Tool、不访问华为云。
3. `tools/list` 必须恰好返回 `cloud_capabilities_search`、`cloud_capability_describe` 和 `cloud_action_execute` 三个工具。缺失、重复、额外暴露审批工具、协议错误、进程退出、15 秒超时或合并输出超过 1 MiB 均 fail closed，并触发首装事务回滚。
4. 该进程握手对四宿主共同执行。CodeArts 仍同时要求固定配置与 Skill 证据；不调用未经确认的 `codearts` 枚举子命令。
5. 该证据证明 CodeArts 配置所指向的 Router 进程可以启动并暴露冻结工具面，但不证明 CodeArts GUI/会话已经读取配置。真实 CodeArts 会话加载、点击审批和同账号进程/loopback 隔离仍属于发布验收。

## 结果

- 四宿主首装都经过同一真实 Router/MCP 子进程启动验证，CodeArts 不再只有静态文件 hash 证据。
- verifier 不依赖产品 MCP、KooCLI 或真实 AK/SK，测试可以完全无云运行。
- 不引入第四个 Tool、密码审批、守护进程、动态注册表或通用适配器层。
