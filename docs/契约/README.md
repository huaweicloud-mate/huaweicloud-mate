# M0 契约索引

状态：Draft for M0

本目录保存 Proposed v0.3-lite 的机器可读契约和测试向量。契约以 ADR-0007、ADR-0008 和 ADR-0009 为决策基线。

## 契约文件

- `router-tools-v1-lite.schema.json`：search、describe、execute 的输入输出；
- `capability-v1-lite.schema.json`：静态能力、复合风险、执行器与输出策略；
- `provider-v1-lite.schema.json`：内置 Provider descriptor 与运行时兼容握手；
- `credential-session-v1.schema.json`：AK/SK 短会话、实例路由和单 session 撤销；
- `approval-v1.schema.json`：危险操作预览与可信审批凭据；
- `host-template-v1-lite.schema.json`：四宿主声明式安装模板；
- `koocli-policy-v1-lite.schema.json`：KooCLI 兼容范围、固定版本、下载摘要与验证；
- `m0-contract-vectors.json`：正反例和状态机测试向量。
- `端到端验收场景草案.md`：5 个覆盖读取、复合风险、执行器锁定、结果未知和敏感读取的场景。
- `M0外部绑定审计.md`：独立校验结果、官方资料核验和仍需外部责任人补齐的阻塞项。

## 固定规则

1. schema 使用 JSON Schema Draft 2020-12，并默认 `additionalProperties: false`。
2. Agent、Prompt、Skill、workspace 和普通 Tool 参数均不能覆盖 endpoint、可执行路径、审批签发器或凭证位置。
3. 未知 schema 版本、未知风险、Provider 契约失配、输出结构失配均 fail closed。
4. capability 内嵌 schema 禁止远程 `$ref`、动态引用和自定义可执行关键字，并受深度、节点数和正则复杂度限制。
5. 只有普通 read 可以直接执行；所有 write、复合风险和敏感读取必须获得可信 `approvalReceipt`。
6. `previewId` 与 receipt 在 dispatch 前原子消费；失败、超时和 `OUTCOME_UNKNOWN` 不恢复为可重试状态。
7. v1 摘要和签名载荷使用 RFC 8785 JCS，摘要使用 SHA-256；receipt 最长有效 300 秒，允许时钟偏差最长 30 秒。
8. session 最长 900 秒，只在 Provider 实例内存中保存；数据面使用 `Hwc-Credential-Session` 和 `Hwc-Session-Route`，后者保证请求命中创建实例。
9. `npx` 仅为安装入口，宿主长期配置只指向用户目录下的稳定 launcher。
10. 开发态 reference provider 不接收真实 AK/SK、不访问云资源且不进入正式 Provider 清单；真实 Provider 通过相同 descriptor/handshake 契约替换。
11. 四宿主统一使用 `huaweicloud-mate.local-approval` 受信 companion；它按需启动、不暴露为普通 Tool，并以每安装实例独立 Ed25519 密钥签发 receipt。

## 独立校验记录

2026-07-13 使用仓库外临时安装的 `python-jsonschema 4.25.1`、`Draft202012Validator` 与离线 `referencing Registry` 完成校验：

- 7 个 schema 均通过 Draft 2020-12 元 schema 检查；
- 7 个测试向量的 schema 层结果均与声明一致；
- `provider-handshake-digest-mismatch-rejected` 与 `approval-receipt-accepted-once` 按设计先通过结构校验，分别留给运行时握手语义和单次消费状态机验证；
- 3 个状态机向量已纳入契约，但必须在后续运行时实现中执行，不能由 JSON Schema 单独判定；
- 所有 schema 通过显式本地 registry 解析，校验过程未获取远程 `$ref`。

2026-07-13 工程注册表进一步使用 `Ajv 8.20.0` strict mode 编译全部 7 个 schema，并执行 7 个 schema 层测试向量。该检查修正了条件分支缺少显式类型以及 URN schema 使用相对跨文件 `$ref` 的问题；`npm test` 和 `huaweicloud-mate doctor --contracts-only` 均通过。

## M0 尚未绑定的外部输入

- 公共 npm scope 与发布身份；
- 统一受信审批 companion 的实现验证、私钥权限和责任人；
- `auth set` 使用的固定只读账号身份校验能力；
- 首发产品 MCP 清单、同源 endpoint、版本范围和 capability digest；
- KooCLI 兼容范围、固定版本、下载 URL 与 SHA-256；
- 最终 3～5 个真实端到端验收场景及责任人。

上述输入未补齐前，本目录保持 `Draft for M0`，不得标记为 Frozen。
