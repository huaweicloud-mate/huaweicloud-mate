# ADR-0010：Router 内部审批回执交接

状态：Accepted

日期：2026-07-14

## 背景

ADR-0008 冻结了危险操作的 preview、可信审批回执和一次性消费语义，ADR-0009 选择 npm 内置的一次性受信 companion 作为四宿主统一审批方式。开发态 Router 与 stdio MCP 随后证明了三工具、preview、companion、回执验签和原子 dispatch 可以分别工作，但既有 Draft 仍要求 Agent 在第二次 `execute` 中提交 `approvalReceipt`。

这个交接方式会让受信回执进入 Agent 上下文，并要求 companion 或 Router 通过未定义的 Tool/metadata 通道把回执交给 Agent。它既不是必要的安全边界，也与 companion 不得成为第四个 Tool 的决策冲突。

## 决策

公开 `cloud_action_execute` 输入不接受 `approvalReceipt`。危险操作保持两个 Tool 调用阶段：

1. 第一次 `execute` 不带 `previewId`，Router 校验并锁定 capability、规范化参数、scope、executor、账号身份和 credentials generation，返回 preview 与确认摘要。
2. 第二次 `execute` 重复相同的 capability、参数和 scope，并只额外携带 `previewId`。Router 校验待审批状态后，在该调用内部按固定路径启动受信 companion，等待用户在独立本地页面点击批准或拒绝。
3. companion 只通过 Router 的私有 IPC 返回回执。Router 在内部完成 schema、签名、session、challenge、参数摘要、executor、凭证代次、账号、scope 和时效校验；回执不进入 Tool 输入、Tool 输出、Agent 上下文或普通日志。
4. 批准后 Router 再读取一次账号身份和 credentials generation，并在第一个 dispatch `await` 前把 preview 同步转换为 `consumed`。随后才调用锁定的执行器。

同一 preview 的并发第二阶段调用共享一次 review；只有一个调用可以消费并 dispatch。用户拒绝、账号变化或 credentials generation 变化都会消费该 preview，避免重放或重复弹窗。companion 启动失败、审批 UI 故障或进程超时不会自动批准，也不消费仍未过期的 preview，调用方可显式重试第二阶段。执行失败、超时和 `OUTCOME_UNKNOWN` 仍不得恢复 preview。

审批仍必须由明确用户点击产生，不增加密码验证、OS Keyring、常驻 daemon、第四个 Tool、隐藏 MCP metadata 或自动批准路径。

## 影响

- Agent 只能引用不透明 `previewId`，不能构造、替换、缓存或转发审批回执。
- Router tools Draft schema 删除公开 `approvalReceipt` 字段；Agent 提交该字段会因 `additionalProperties: false` 被拒绝。
- `approval-v1` 回执契约继续作为 Router 与 companion 的内部安全契约，不被删除或弱化。
- stdio MCP 的危险流程在协议层形成三工具、两 Tool 调用阶段的闭环；四宿主安装目录真实性、进程/loopback 隔离和真实交互 probe 仍是发布门禁。
- 本 ADR 仅修订 ADR-0008 和 ADR-0009 中“由第二次 Tool 调用携带回执”的表述；其余风险、签名、时效、一次性消费和 companion 决策继续有效。

## 明确不采用

- 不让 Agent、Prompt、Skill 或普通 Tool 参数接触 `approvalReceipt`；
- 不把 companion 注册为第四个 Tool；
- 不通过未标准化的 MCP metadata 或宿主私有事件桥接传递回执；
- 不使用密码输入、自动批准、`--yes` 或环境变量批准；
- 不恢复 Proposed v0.2 的五工具、动态 Registry、通用 Adapter SPI 或独立凭证控制面。
