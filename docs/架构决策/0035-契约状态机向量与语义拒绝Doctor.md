# ADR-0035：契约状态机向量与语义拒绝 Doctor

状态：Accepted
日期：2026-07-15

## 背景

M0 向量文件除 9 个 schema 向量外，还定义了 3 个状态机向量。旧 doctor 只编译 schema，并把状态机向量计为 deferred；`semantic-reject` 也只验证实例符合 schema，没有执行 descriptor digest 失配规则。这会产生“测试绿但冻结语义未执行”的假证据。

## 决策

1. `doctor --contracts-only` 必须在无云、无真实凭证的本地 harness 中执行全部状态机向量，`deferredStateMachineVectorCount` 固定为 `0`。
2. `approval-replay` 使用真实 Router preview/review/dispatch，证明首次提交完成、同 preview 同执行器重放返回 `APPROVAL_REPLAYED`。harness reviewer 只接受固定的无云参考 capability、测试账号和 provider 执行器，并返回故意无法通过生产 Ed25519 验签的结构化回执；它不是自动审批或签名入口。
3. `outcome-unknown-does-not-unlock-executor` 使用真实 Router 和两个无云 adapter，证明 provider 返回 `OUTCOME_UNKNOWN` 后 KooCLI dispatch 次数仍为零，任何更换执行器请求返回 `EXECUTOR_LOCKED`。
4. `credential-generation-changed` 使用本地 OBS session manager 和无网络 client，证明旧 generation 被撤销后复用返回 `AUTH_SESSION_EXPIRED`，重复撤销保持 best effort。
5. 状态机 ID、步骤顺序或期望字段发生漂移时返回 `VECTOR_SHAPE_MISMATCH`，不得静默跳过。
6. `semantic-reject` 必须调用明确的语义 validator。当前 Provider handshake 向量比较内置 descriptor digest 与 handshake `capabilityDigest`；schema 合法但 digest 不相等时，`semanticValid=false` 才算通过拒绝向量。

## 结果

- 构建后的正式 CLI 会报告 9 个 schema 向量、3 个状态机向量和 0 个 deferred。
- doctor harness 不访问华为云、不读取用户 credentials、不调用 KooCLI，也不产生资源副作用。
- 该证据不替代真实产品 Provider endpoint/digest 绑定或四宿主交互隔离验收。
