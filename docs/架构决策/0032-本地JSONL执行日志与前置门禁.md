# ADR-0032：本地 JSONL 执行日志与前置门禁

状态：Accepted
日期：2026-07-15

## 背景

Proposed v0.3-lite 要求保留最小本地执行日志，但日志不能成为第二套事务系统，也不能记录 AK/SK、session、route token、审批回执、参数正文、敏感响应或异常堆栈。对于有副作用的 dispatch，日志失败发生在请求前后具有不同语义：请求前可以安全停止，请求后不能把已知成功改写成可重试失败。

## 决策

1. Router 只向固定结构的 `huaweicloud-mate-audit/v1` sink 写入事件，不接受任意日志消息或异常文本。
2. 事件记录时间、归一化 Agent、插件版本、correlation ID、capability/product、executor、scope、风险、审批结果、参数/结果 SHA-256 摘要、request ID、耗时和错误分类。
3. 不记录参数/结果正文、账号身份、credential generation、preview/challenge、receipt、session ID、route token、Authorization、签名或错误 message/stack。
4. `preview-created` 和 `dispatch-started` 必须在返回 preview 或调用执行器前成功写入；失败时 fail closed，执行器不得运行。
5. dispatch 结束后的 `dispatch-completed`/`dispatch-failed` 采用尽力记录。若云调用已经得到确定结果，日志介质故障不得把结果改写为可重试失败；已写入的 `dispatch-started` 可用于识别日志缺口。
6. JSONL 位于固定用户数据目录、运行时目录之外。目录和文件使用既有 POSIX owner/`0600` 或 Windows 当前用户 ACL 策略；拒绝 symlink/非普通文件，单行最大 16 KiB，主文件超过 8 MiB 时保留一个固定轮转备份。
7. MCP client name 只归一化为 `codex`、`claude`、`opencode`、`codearts` 或 `unknown-mcp-client`，不把不受信客户端字符串直接写入日志。

## 结果

- 本地 JSONL 基础已进入真实 stdio Router，而不是只存在于文档或测试 fixture。
- 日志不会扩展成通用审计平台、遥测、事件总线或 Proposed v0.2 的治理层。
- 自动化测试用 AK/SK 哨兵验证参数、结果、session 与内部 trace 不落盘，并验证 dispatch 前/后日志故障语义。
