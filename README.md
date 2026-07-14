# huaweicloud-mate

面向 Agent 的华为云统一工具插件。目前项目采用 **Proposed v0.3-lite**，已进入 M1 工程基础阶段；契约仍保持 Draft，尚无可用于真实云资源操作的发布版本。

## 已确认的首版架构

- Agent 只看到 `search`、`describe`、`execute` 三个 Router tools。
- 正式产品 MCP Provider 静态随包发布；能力已覆盖时优先使用 MCP，未覆盖时仅在执行前回退 KooCLI。真实 MCP 到位前仅使用不访问云资源的开发态 reference provider 验证契约。
- 危险操作由 `execute` 执行两阶段确认：首次调用返回 preview，第二次调用只携带 `previewId`；Router 在调用内部启动受信审批 companion、验签回执并原子 dispatch，回执不进入 Agent 上下文。
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
- [ADR-0010：Router 内部审批回执交接](docs/架构决策/0010-Router内部审批回执交接.md)

## 当前限制

当前工程已包含契约注册表、CLI doctor、stdio MCP 三工具服务、静态开发态 capability catalog、最小 Router `preview/execute` 状态机和受信审批 companion 核心。开发态 reference executor 只返回确定性本地数据，不读取凭证、不访问华为云；Router 在结果进入 Agent 前执行 output schema、大小和 JSON Pointer 敏感路径脱敏。`doctor --approval-probe` 可执行一次无云副作用的真实交互探测；审批只需点击批准或拒绝，不要求输入密码。

开发服务可通过 `npm run mcp` 启动。三工具 Draft 已冻结开发态危险流程：第二次 `execute` 只提交原输入和 `previewId`，Router 内部完成浏览器审批、回执验签、凭证复核与原子 dispatch；不增加第四个 Tool，也不要求密码。它仍不是可安装的正式插件：真实产品 MCP、KooCLI、账号身份校验、稳定安装目录、runtime manifest 真实性和四宿主进程/loopback 隔离仍是发布门禁。请勿提供真实 AK/SK。
