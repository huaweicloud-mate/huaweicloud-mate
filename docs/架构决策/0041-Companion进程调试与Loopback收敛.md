# ADR-0041：Companion 进程调试与 Loopback 收敛

状态：Accepted
日期：2026-07-15

## 背景

ADR-0037～0039 已关闭主 CLI、companion 入口和审批契约在摘要校验后的路径重读窗口，但发布门禁仍要求限制 companion 的调试/注入面和 loopback 审批页暴露。四宿主对同账号 Agent 的 sandbox 隔离必须在真实会话中验证；工程侧仍应先消除无需宿主配合即可关闭的入口。

## 决策

1. 正式 companion 与开发 fixture 均以显式 `--disable-sigusr1` 启动，不继承父进程 `execArgv`。正式 bootstrap 在读取已验签 envelope 前确认 inspector 未激活，并拒绝 inspect/debug 参数。
2. launcher 只传递浏览器会话所需的固定环境 allowlist。bootstrap 额外拒绝 `NODE_OPTIONS`、`NODE_PATH`、Node debug/coverage 和 TLS key log 等注入或转储环境；审批上下文、入口源码和契约仍只走继承 stdin/私有 IPC。
3. loopback 服务只绑定并接受 IPv4 `127.0.0.1`，严格匹配随机端口 Host。含 256-bit 随机 path token 的审批页只成功返回一次，后续读取返回 `410`，使窃取/抢占不再能够无痕旁路真实浏览器。
4. 决策 POST 继续要求同源 Origin 与 256-bit CSRF，并改为严格 content type、精确且不重复的 `csrf + decision` 两字段。服务设置有界 headers/request/keep-alive 时限和每连接请求数。
5. 页面增加 no-store、CSP、frame、referrer、cross-origin resource 与 browser permissions 限制；一次 decision 后立即关闭服务，审批 UI 仍不暴露为 MCP Tool。
6. path token 必须交给系统浏览器，因此会短暂存在于浏览器启动参数；同账号恶意进程仍可能竞速读取或使用 OS 调试/进程检查能力。本 ADR 只收敛本地实现面，不把自动测试表述为四宿主强制隔离证明。

## 结果

- 构建后 launcher 测试证明已验签内存入口在无 inspector、禁用 SIGUSR1、无 Node 注入环境下运行；不满足时 bootstrap 在发送 review 前 fail closed。
- loopback 测试证明页面只能读取一次、错误 Origin 与重复字段均被拒绝，正常点击批准/拒绝仍可完成。
- Codex、Claude Code、OpenCode 和码道的真实 `doctor --approval-probe`、Agent 进程/调试/URL 枚举与表单自动提交隔离仍是发布验收项。
