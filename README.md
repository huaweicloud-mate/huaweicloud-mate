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
- [ADR-0011：版本化运行时与稳定 Launcher](docs/架构决策/0011-版本化运行时与稳定Launcher.md)
- [ADR-0012：四宿主路径绑定与 Canonical Skill 生成](docs/架构决策/0012-四宿主路径绑定与Canonical-Skill生成.md)
- [ADR-0013：宿主配置事务与 Hash 安全回滚](docs/架构决策/0013-宿主配置事务与Hash安全回滚.md)
- [ADR-0014：宿主资产 Staging 与 Hash 安全物化](docs/架构决策/0014-宿主资产Staging与Hash安全物化.md)
- [ADR-0015：最小 Install-State 状态信封](docs/架构决策/0015-最小Install-State状态信封.md)
- [ADR-0016：首装事务编排与逆序安全回滚](docs/架构决策/0016-首装事务编排与逆序安全回滚.md)
- [ADR-0017：四宿主只读发现与验证钩子](docs/架构决策/0017-四宿主只读发现与验证钩子.md)

## 当前限制

当前工程已包含契约注册表、CLI doctor、stdio MCP 三工具服务、静态开发态 capability catalog、最小 Router `preview/execute` 状态机、受信审批 companion 核心，以及完整安装清单、版本化运行时物化和稳定 launcher。四宿主真实用户级路径与原生 MCP 形态已固化为内置模板；单一 Canonical Skill 会在构建时生成 Codex/Claude 插件与通用 Skills 产物，两类插件 manifest 均已接入实际校验。宿主配置事务已支持严格 JSON、保留注释的 JSONC、同名冲突、权限受限备份、原子替换和基于安装前后 hash 的安全回滚；插件/Skills 资产也已支持安装清单复验、staging 渲染、完整 tree hash、幂等冲突和 quarantine 安全回滚。最小 install-state 已能严格绑定 runtime/config/assets 证据，支持清单复验、幂等/CAS 写入和 hash 安全回滚；首装协调器会在提交状态前完成只读复核、Codex/Claude/OpenCode 列表发现、华为云码道配置级证据检查和一次点击式审批探针，并在失败时逆序回滚配置与资产。开发态 reference executor 只返回确定性本地数据，不读取凭证、不访问华为云；Router 在结果进入 Agent 前执行 output schema、大小和 JSON Pointer 敏感路径脱敏。`doctor --approval-probe` 可执行一次无云副作用的真实交互探测；审批只需点击批准或拒绝，不要求输入密码。

开发服务可通过 `npm run mcp` 启动。三工具 Draft 已冻结开发态危险流程：第二次 `execute` 只提交原输入和 `previewId`，Router 内部完成浏览器审批、回执验签、凭证复核与原子 dispatch；不增加第四个 Tool，也不要求密码。稳定 launcher 已能从固定版本目录启动自包含 Router，并在启动前校验完整制品清单。它仍不是可安装的正式插件：真实 marketplace/宿主注册写入事务、华为云码道进程级发现、受管资产升级、`install/uninstall` CLI、真实产品 MCP、KooCLI、账号身份校验和四宿主隔离仍是发布门禁。请勿提供真实 AK/SK。
