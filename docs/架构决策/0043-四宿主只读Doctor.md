# ADR-0043：四宿主只读 Doctor

状态：Accepted
日期：2026-07-15

## 背景

安装事务已经在提交 install-state 前验证宿主配置、资产、原生注册、稳定 Router 进程和审批探针，但 CLI 的公开 `doctor` 只能检查契约、审批或 KooCLI。用户无法在安装后以只读方式判断四宿主是否存在、是否由插件管理或是否发生配置/Skill/注册漂移，也不能明确区分“宿主未安装”和“受管安装损坏”。

## 决策

1. 新增互斥模式 `doctor --hosts [--json]`，仍先执行契约 doctor，再检查 Codex、Claude Code、OpenCode 和码道。它不触发 approval、不读取 credentials、不访问云端。
2. 对每个宿主只报告固定 ID/display name、命令是否发现、检测路径数量、是否受管、固定状态、检查类型及归一化错误码；不输出命令绝对路径、用户目录、配置内容或异常文本。
3. 无 install-state 时，发现的宿主为 `available`，未发现为 `not-detected`，整体返回失败以明确提示尚未形成受管安装。运行时或状态无效时顶层为 `invalid`，不得猜测受管关系。
4. 有 install-state 时，从严格验证过的状态重建固定宿主 plan，复验配置/资产、Codex/Claude marketplace 与 activation、OpenCode MCP/Skill discovery、宿主发现以及稳定 Router 的真实 MCP 三工具握手。成功为 `managed`，任何失配为 `drifted`。
5. 只有存在至少一个健康 managed 宿主，且所有当前检测到的宿主都已受管、其余宿主确实未检测到时，host doctor 才返回 `ok=true`。这为后续无 `--host` 自动多宿主安装保留严格退出语义。
6. 原安装验证拆出无需审批的共享复验核心；初装仍在其后单独运行点击式 approval probe，因此本 ADR 不削弱安装提交门禁。

## 结果

- 自动化测试覆盖未安装但可用、健康受管安装和 Skill 篡改三类状态；报告不含 runtime/home 路径。
- `doctor --hosts` 可作为真实宿主会话验收前的统一本地证据，但不能证明 Agent sandbox 无法枚举浏览器 URL、IPC 或 OS 调试能力。
- 当前 CLI 的自动多宿主安装/升级编排仍需后续实现；doctor 会把“检测到但未受管”的宿主保持为失败，而不是掩盖该缺口。
