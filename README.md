# huaweicloud-mate

面向 Agent 的华为云统一工具插件。目前项目处于 **M0 契约冻结阶段**：Proposed v0.3-lite 架构与安全契约已有 Draft，但尚无可安装的 npm 包、CLI 或运行时代码。

## 已确认的首版架构

- Agent 只看到 `search`、`describe`、`execute` 三个 Router tools。
- 官方产品 MCP Provider 静态随包发布；能力已覆盖时优先使用 MCP，未覆盖时仅在执行前回退 KooCLI。
- 危险操作由 `execute` 执行两阶段确认，第二阶段必须携带受信宿主签发的 `approvalReceipt`。
- 凭证使用 generation 与 route token 管理；产品 MCP 仅在同域 HTTPS 会话中短时持有 AK/SK。
- 首版不恢复 Proposed v0.2 的动态 Registry、独立凭证控制面、mTLS、信封加密、通用 Adapter SPI 或五工具设计。

## 设计与契约

- [技术架构](docs/技术架构.md)
- [安全架构](docs/安全架构.md)
- [产品 MCP 接入规范](docs/产品MCP接入规范.md)
- [智能体适配器接口规范](docs/智能体适配器接口规范.md)
- [首版实施路线图](docs/首版实施路线图.md)
- [M0 契约说明](docs/契约/README.md)

## 当前限制

仓库当前不包含应用工程代码，也不能作为 npm 包或 MCP Server 运行。请勿通过环境变量、工具参数或日志传递 AK/SK；具体安装和认证方式将在后续工程阶段实现并验证。

早期 OBS-only 原型已经从活动分支退役，仍可在 Git 历史中追溯。下一步是完成 M0 外部绑定和端到端验收场景；进入 M1 应用工程实现需要单独授权。
