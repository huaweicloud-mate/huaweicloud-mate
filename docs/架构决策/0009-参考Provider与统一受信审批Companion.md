# ADR-0009：开发态参考 Provider 与统一受信审批 Companion

状态：Accepted；公开 Tool 与内部回执的交接方式由 [ADR-0010](0010-Router内部审批回执交接.md) 修订

日期：2026-07-13

后续状态：ADR-0048 将真实产品 MCP 移出首版；本 ADR 的 reference provider 与统一 companion 边界继续有效。

## 背景

Proposed v0.3-lite 要求至少一个内置官方产品 MCP 完成 credential session、兼容握手和真实资源操作验证，但当前无法获得满足该契约的正式产品 MCP。四个目标宿主虽然都有不同程度的用户审批入口，也没有统一、可验证且能绑定 Router challenge 的签名回执接口。

这两个外部依赖不应阻塞本地插件、契约校验、Router、安全状态机和安装器的开发，但开发替身不能被误认为正式产品能力，也不能削弱 ADR-0008 的可信审批边界。

## 决策

### 1. 插件优先，Provider 可替换

- 立即开始单一 TypeScript npm package 的 M1 基础实现，并逐步实现 Router、安全状态机、安装器和 KooCLI Adapter。
- 在开发与自动化测试中提供 `reference-provider`，仅用于验证 Provider descriptor、兼容握手、credential session、路由和错误语义。
- `reference-provider` 不接收真实 AK/SK、不访问真实云资源、不进入正式 Provider 清单，也不得使用“官方产品 MCP”名称或标识。
- Provider 接入继续遵循静态 descriptor 和既有 v1-lite 契约。未来真实产品 MCP 只替换 descriptor、endpoint、capability 数据和测试绑定，不修改 Router 三工具接口或恢复动态 Registry。
- M3 真实端到端退出标准保持不变：至少一个正式产品 MCP 必须通过真实资源操作和凭证生命周期安全测试。

### 2. 四宿主统一使用受信审批 Companion

Codex、Claude Code、OpenCode 和华为云码道统一绑定 npm 内置的本地受信审批 companion，不依赖宿主原生审批事件桥接：

- approval mode：`bundled-trusted-companion`；
- issuer ID：`huaweicloud-mate.local-approval`；
- verifier key ID：`local-approval-ed25519-v1`；
- 签名算法：Ed25519；
- Router 为每次待审批操作通过固定绝对路径启动一个一次性 companion 进程，并建立不暴露给 Agent 的继承管道；
- companion 每次在内存生成独立 Ed25519 密钥，先通过私有管道返回带随机 `approvalSessionId` 的公钥 binding，再在明确用户批准后签发同一 session 的 receipt；
- 私钥不写入磁盘、不使用密码或 OS Keyring，companion 返回批准/拒绝结果后立即退出并销毁密钥；
- companion 由 Router 按需启动，不是常驻 daemon，也不作为 Agent 可调用的普通 Tool 或 MCP tool 暴露；
- 只有 companion 自己展示规范化摘要，并观察到用户明确批准后，才签发绑定 `previewId`、challenge digest、参数摘要、执行器、凭证 generation、账号身份和 scope 的短期 receipt；
- 不提供 `--yes`、环境变量自动批准、宿主配置自动批准或可由 Prompt/Skill 触发的非交互签发路径；
- `doctor` 必须执行无云资源副作用的 challenge/receipt/verify 探测。

宿主原生审批 UI 可以保留为额外的用户提示，但不作为 v1-lite 强制安全边界的 receipt 来源。

### 2.1 当前实现状态

开发态 TypeScript 核心已实现一次审批一次的内存 Ed25519 密钥、严格 ready/result message、`approvalSessionId` 绑定、构建时完整运行时制品摘要清单、启动前逐文件 SHA-256/symlink 校验、最小环境和空 `execArgv`、Node 私有父子 IPC、受限本地浏览器审批页、receipt 签发、Router 验签、最长五分钟时效和进程内原子一次性消费。最小 Router `preview/execute` 状态机默认使用该固定 launcher，并实现参数、scope、执行器、账号与凭证代次绑定、并发消费及结果未知不回退；`doctor --approval-probe` 已提供无凭证、无云副作用的显式交互探测。测试覆盖非交互、拒绝、Host/Origin/CSRF/CSP、UI 控制字符、错误制品摘要、上下文不进入 argv/env、错误 session 公钥、篡改、过期、重放、并发消费和 `OUTCOME_UNKNOWN`。

stdio MCP 已固定只暴露三个工具，并接入开发态 catalog、普通 read 和危险两阶段调用。依据 ADR-0010，第二次调用只携带 `previewId`，Router 在内部启动 companion、验证回执、复核凭证并原子 dispatch，回执不进入 Agent 上下文。该实现仍不是正式安全边界：安装器和真实执行器尚未实现，runtime manifest 自身真实性、摘要校验到进程启动间的替换窗口、同账号调试/注入、loopback 端口与浏览器自动化威胁仍需四宿主验证。自动化测试只验证 fixture 协议，发布前仍须由用户在四宿主实际运行交互 probe。无法证明隔离的宿主不得宣称强制审批。

### 3. 当前工程与发布边界

- 当前开发包使用私有、不可发布的临时 npm identity；公共 npm scope 与发布身份另行绑定。
- 第一批工程实现只包含包骨架、契约注册与校验、CLI/doctor 基础和 reference provider 测试夹具，不处理真实 AK/SK，不执行云资源操作。
- KooCLI 固定制品、真实账号身份校验能力和真实产品 MCP 仍是后续集成/发布门禁。

## 影响

- M1/M2 的本地核心工作可以在真实产品 MCP 到位前推进。
- 四宿主审批语义一致，不需要为每个宿主实现不同的安全回执桥接。
- companion 成为本地可信计算基的一部分，后续必须接受私钥权限、UI 欺骗、回执重放和二进制替换测试。
- reference provider 只能证明契约和集成逻辑正确，不能证明真实产品 MCP 的安全性、可用性或云操作正确性。

## 明确不采用

- 不恢复 Proposed v0.2 的动态 Registry、通用 Adapter SPI、独立凭证控制面、mTLS、信封加密或五工具设计。
- 不把普通宿主工具审批、Agent 回传 token 或普通 Tool 参数视为可信审批。
- 不把开发态 reference provider 随正式版本声明为华为云官方产品 MCP。
