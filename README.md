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
- [ADR-0018：Codex 个人 Marketplace 布局与安全注册文件事务](docs/架构决策/0018-Codex个人Marketplace布局与安全注册文件事务.md)
- [ADR-0019：Codex 注册证据与首装回滚编排](docs/架构决策/0019-Codex注册证据与首装回滚编排.md)
- [ADR-0020：Codex CLI 激活证据与保守回滚](docs/架构决策/0020-Codex-CLI激活证据与保守回滚.md)
- [ADR-0021：Codex 单宿主安装卸载 CLI 与 Ownership 清理](docs/架构决策/0021-Codex单宿主安装卸载CLI与Ownership清理.md)
- [ADR-0022：Codex 受管重装升级与候选 Runtime 提交](docs/架构决策/0022-Codex受管重装升级与候选Runtime提交.md)
- [ADR-0023：Codex 升级中断恢复标记与保守收敛](docs/架构决策/0023-Codex升级中断恢复标记与保守收敛.md)
- [ADR-0024：Claude 本地 Marketplace 目录与 CLI 注册事务](docs/架构决策/0024-Claude本地Marketplace目录与CLI注册事务.md)
- [ADR-0025：Claude 插件激活证据与保守卸载](docs/架构决策/0025-Claude插件激活证据与保守卸载.md)
- [ADR-0026：Claude 单宿主安装状态与依赖安全清理](docs/架构决策/0026-Claude单宿主安装状态与依赖安全清理.md)

## 当前限制

当前工程已包含契约注册表、CLI doctor、stdio MCP 三工具服务、静态开发态 capability catalog、最小 Router `preview/execute` 状态机、受信审批 companion 核心，以及完整安装清单、版本化运行时物化和稳定 launcher。四宿主真实用户级路径与原生 MCP 形态已固化为内置模板；单一 Canonical Skill 会在构建时生成 Codex/Claude 插件与通用 Skills 产物，两类插件 manifest 均已接入实际校验。宿主配置事务已支持严格 JSON、保留注释的 JSONC、同名冲突、权限受限备份、原子替换和基于安装前后 hash 的安全回滚；插件/Skills 资产也已支持安装清单复验、staging 渲染、完整 tree hash、幂等冲突和 quarantine 安全回滚。Codex 插件已按个人 marketplace 约定绑定到 `~/plugins/huaweicloud-mate`；marketplace 严格 JSON 事务、结构化 CLI add/list/remove 激活、注册与启用 ownership 证据、install-state 绑定和首装依赖安全回滚已完成。`install --host codex` 现已把运行时物化、宿主验证和无云审批探针接成首装入口；`uninstall --host codex` 会重新绑定固定路径、预检 identity/hash，只撤销本次拥有且未漂移的 activation、marketplace、asset 和状态，同时保留 runtime 与凭证。最小 install-state 已能严格绑定 runtime/config/assets/registration/activation 证据，支持清单复验、幂等/CAS 写入和 hash 安全回滚。开发态 reference executor 只返回确定性本地数据，不读取凭证、不访问华为云；Router 在结果进入 Agent 前执行 output schema、大小和 JSON Pointer 敏感路径脱敏。`doctor --approval-probe` 可执行一次无云副作用的真实交互探测；审批只需点击批准或拒绝，不要求输入密码。

开发服务可通过 `npm run mcp` 启动。三工具 Draft 已冻结开发态危险流程：第二次 `execute` 只提交原输入和 `previewId`，Router 内部完成浏览器审批、回执验签、凭证复核与原子 dispatch；不增加第四个 Tool，也不要求密码。稳定 launcher 已能从固定版本目录启动自包含 Router，并在启动前校验完整制品清单。Codex 单宿主现已具备首装、同版本幂等重装、跨版本受管升级、安全卸载和严格的升级中断恢复门禁；候选 runtime 不提前激活，常规失败会恢复旧 state/pointer/asset/activation，进程强制终止后的可证明现场会在下一次 install 前保守收敛。Claude 本地 catalog、marketplace registration 和 plugin activation 已纳入严格 install-state，`install/uninstall --host claude` 支持首装、同版本复核、点击式无密码审批探针和依赖安全清理；Windows npm shim 只在能严格解析到同目录树内同名原生可执行文件时被接受，runner 始终不启用 shell。它仍不是可发布的正式插件：Claude 跨版本受管升级、OpenCode/码道入口与进程级发现、真实产品 MCP、KooCLI、账号身份校验和四宿主隔离仍是发布门禁。请勿提供真实 AK/SK。
