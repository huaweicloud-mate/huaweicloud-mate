# huaweicloud-mate

面向 Agent 的华为云统一工具插件。目前项目采用 **Proposed v0.3-lite**，已进入 M1 工程基础阶段；契约仍保持 Draft，尚无可用于真实云资源操作的发布版本。

## 已确认的首版架构

- Agent 只看到 `search`、`describe`、`execute` 三个 Router tools。
- 正式产品 MCP Provider 静态随包发布；能力已覆盖时优先使用 MCP，未覆盖时仅在执行前回退 KooCLI。真实 MCP 到位前仅使用不访问云资源的开发态 reference provider 验证契约。
- 危险操作由 `execute` 执行两阶段确认，第二阶段必须携带统一受信审批 companion 签发的 `approvalReceipt`。
- 凭证使用 generation 与 route token 管理；产品 MCP 仅在同域 HTTPS 会话中短时持有 AK/SK。
- 首版不恢复 Proposed v0.2 的动态 Registry、独立凭证控制面、mTLS、信封加密、通用 Adapter SPI 或五工具设计。

## 设计与契约

- [技术架构](docs/技术架构.md)
- [安全架构](docs/安全架构.md)
- [产品 MCP 接入规范](docs/产品MCP接入规范.md)
- [智能体适配器接口规范](docs/智能体适配器接口规范.md)
- [首版实施路线图](docs/首版实施路线图.md)
- [M0 契约说明](docs/契约/README.md)
- [ADR-0009：参考 Provider 与统一受信审批 Companion](docs/架构决策/0009-参考Provider与统一受信审批Companion.md)

## 当前限制

当前工程已包含契约注册表、CLI doctor、最小 Router `preview/execute` 状态机和受信审批 companion 核心：一次审批一次的内存 Ed25519 密钥、固定制品摘要、私有父子 IPC、受限本地浏览器审批页、receipt 签发/验签、参数/执行器/账号代次绑定，以及 dispatch 前的原子一次性消费。`doctor --approval-probe` 可执行一次不读取凭证、不访问云资源的真实交互探测；审批只需点击批准或拒绝，不要求输入密码。它仍不能作为可安装的正式插件或 MCP Server 使用。请勿提供真实 AK/SK，也不要通过环境变量、工具参数或日志传递凭证。

早期 OBS-only 原型已经从活动分支退役，仍可在 Git 历史中追溯。审批 launcher 已接入最小 Router 核心和 doctor，但 stdio MCP 三工具服务、静态正式能力清单、真实执行器、安装目录真实性、同账号进程隔离及浏览器自动化威胁仍未完成；真实产品 MCP、固定 KooCLI 制品、账号身份校验和四宿主端到端场景仍是后续发布门禁。当前输出脱敏尚未实现，声明敏感路径的能力会 fail closed。
