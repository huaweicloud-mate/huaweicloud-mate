# M0 契约索引

状态：Draft for M0

本目录保存 Proposed v0.3-lite 的机器可读契约和测试向量，不是应用工程代码。契约以 ADR-0007 和 ADR-0008 为决策基线。

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

## M0 尚未绑定的外部输入

- 公共 npm scope 与发布身份；
- 四宿主各自可验证的审批签发方式和 issuer ID；
- `auth set` 使用的固定只读账号身份校验能力；
- 首发产品 MCP 清单、同源 endpoint、版本范围和 capability digest；
- KooCLI 兼容范围、固定版本、下载 URL 与 SHA-256；
- 最终 3～5 个真实端到端验收场景及责任人。

上述输入未补齐前，本目录保持 `Draft for M0`，不得标记为 Frozen。
