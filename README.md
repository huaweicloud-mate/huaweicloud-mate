# huaweicloud-mate

面向 Agent 的华为云统一工具插件。目前项目采用 **Proposed v0.3-lite**，已进入 M1/M2 工程实现；契约仍保持 Draft，尚无正式发布版本。

## 已确认的首版架构

- Agent 只看到 `search`、`describe`、`execute` 三个 Router tools。
- 首版不接入真实产品 MCP；内置本地 OBS provider 提供列桶、审批后读取有界文本对象、创建私有桶和删除空桶，KooCLI 作为后续能力补位。静态 Provider descriptor、Streamable HTTP client、credential-session、health/digest 和 MCP 优先路由入口保留，真实产品 MCP 后续通过新插件版本接入。
- 危险操作由 `execute` 执行两阶段确认：首次调用返回 preview，第二次调用只携带 `previewId`；Router 在调用内部启动受信审批 companion、验签回执并原子 dispatch，回执不进入 Agent 上下文。
- 凭证使用 generation 与 route token 管理；当前本地 OBS provider 只在进程内短时持有 AK/SK，后续产品 MCP 仍必须使用同域 HTTPS 短会话。
- 首版不恢复 Proposed v0.2 的动态 Registry、独立凭证控制面、mTLS、信封加密、通用 Adapter SPI 或五工具设计。

## 设计与契约

- [技术架构](docs/技术架构.md)
- [安全架构](docs/安全架构.md)
- [产品 MCP 接入规范](docs/产品MCP接入规范.md)
- [智能体适配器接口规范](docs/智能体适配器接口规范.md)
- [首版实施路线图](docs/首版实施路线图.md)
- [使用与故障诊断](docs/使用与故障诊断.md)
- [发布流程](docs/发布流程.md)
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
- [ADR-0027：本地最小 OBS Provider 与短会话替身](docs/架构决策/0027-本地最小OBS-Provider与短会话替身.md)
- [ADR-0028：KooCLI 私有制品与凭证执行门禁](docs/架构决策/0028-KooCLI私有制品与凭证执行门禁.md)
- [ADR-0029：Claude 升级中断恢复标记与保守收敛](docs/架构决策/0029-Claude升级中断恢复标记与保守收敛.md)
- [ADR-0030：稳定 Router 进程握手作为码道启动证据](docs/架构决策/0030-稳定Router进程握手作为码道启动证据.md)
- [ADR-0031：OBS 空桶删除与结果未知门禁](docs/架构决策/0031-OBS空桶删除与结果未知门禁.md)
- [ADR-0032：本地 JSONL 执行日志与前置门禁](docs/架构决策/0032-本地JSONL执行日志与前置门禁.md)
- [ADR-0033：用户级 Runtime 递归权限门禁](docs/架构决策/0033-用户级Runtime递归权限门禁.md)
- [ADR-0034：配置宿主受管升级与中断恢复](docs/架构决策/0034-配置宿主受管升级与中断恢复.md)
- [ADR-0035：契约状态机向量与语义拒绝 Doctor](docs/架构决策/0035-契约状态机向量与语义拒绝Doctor.md)
- [ADR-0036：输出凭证模式兜底拒绝](docs/架构决策/0036-输出凭证模式兜底拒绝.md)
- [ADR-0037：稳定 Launcher 加载已验签 CLI 字节](docs/架构决策/0037-稳定Launcher加载已验签CLI字节.md)
- [ADR-0038：Companion 已验签入口私有管道加载](docs/架构决策/0038-Companion已验签入口私有管道加载.md)
- [ADR-0039：审批契约已验签内存编译](docs/架构决策/0039-审批契约已验签内存编译.md)
- [ADR-0040：OBS 有界文本对象敏感读取](docs/架构决策/0040-OBS有界文本对象敏感读取.md)
- [ADR-0041：Companion 进程调试与 Loopback 收敛](docs/架构决策/0041-Companion进程调试与Loopback收敛.md)
- [ADR-0042：公开源码卫生门禁](docs/架构决策/0042-公开源码卫生门禁.md)
- [ADR-0043：四宿主只读 Doctor](docs/架构决策/0043-四宿主只读Doctor.md)
- [ADR-0044：自动发现多宿主首装与复验](docs/架构决策/0044-自动发现多宿主首装与复验.md)
- [ADR-0045：多宿主协调升级与统一恢复](docs/架构决策/0045-多宿主协调升级与统一恢复.md)
- [ADR-0046：KooCLI 安全 Adapter 与受信调用边界](docs/架构决策/0046-KooCLI安全Adapter与受信调用边界.md)
- [ADR-0047：npm 发布包隔离安装与 Bin 冒烟](docs/架构决策/0047-npm发布包隔离安装与Bin冒烟.md)
- [ADR-0048：首版 KooCLI 官方绑定与产品 MCP 后置](docs/架构决策/0048-首版KooCLI官方绑定与产品MCP后置.md)
- [ADR-0049：KooCLI 首版仅使用永久 AK/SK](docs/架构决策/0049-KooCLI首版仅使用永久AKSK.md)
- [ADR-0050：KooCLI 无配置 argv 凭据授权](docs/架构决策/0050-KooCLI无配置argv凭据授权.md)
- [ADR-0051：首个 ECS 只读 KooCLI 能力](docs/架构决策/0051-首个ECS只读KooCLI能力.md)

## 当前可验证路径

```text
huaweicloud-mate install
huaweicloud-mate auth set
huaweicloud-mate auth status
huaweicloud-mate doctor --koocli
huaweicloud-mate doctor --hosts
huaweicloud-mate doctor --contracts-only --json
huaweicloud-mate mcp
```

`auth set` 只从交互终端非回显读取一组永久 AK/SK，不要求密码、SecurityToken、SSO、profile 名或其他认证材料，并通过固定的 OBS `ListBuckets` 只读请求校验账号。Region、project ID 与 account/domain ID 属于调用 scope 或校验结果，不是额外用户凭据。当前账号必须具备 `obs:bucket:ListAllMyBuckets` 权限。随后 Agent 可经 `search -> describe -> execute` 调用 `huaweicloud.obs.bucket.list.v1`，或在点击审批后调用 OBS 敏感读写能力及 `huaweicloud.ecs.server.list.v1`。ECS 能力通过 KooCLI `ListServersDetails` 最多返回 50 个 server 的 ID、名称和状态，需要 region、project 与 `ecs:cloudServers:listServersDetails` 权限，不返回地址、metadata 或安全组。OBS 文本读取只接受规定 MIME、fatal UTF-8 和最多 64 KiB 正文，credential-like 内容仍会被 Router 拒绝；删除仅面向空桶。创建或删除在请求发出后连接中断均返回 `OUTCOME_UNKNOWN` 且不自动重试。该路径尚未完成真实测试账号验收，不应使用生产高权限凭证。

`doctor --contracts-only` 会执行 9 个 schema 向量、Provider digest 语义拒绝，以及 4 个真实本地状态机向量；replay、执行器锁定、`OUTCOME_UNKNOWN`、credential generation 失效和产品 MCP 执行前不可用时选择安全 KooCLI Adapter 都不再以 deferred 计数通过。

`doctor --hosts` 不读取凭证、不触发审批、不访问云端；它区分未检测、可安装、健康受管和漂移状态，并对受管宿主复验配置、资产、原生注册与稳定 Router MCP 握手。JSON 报告只含固定状态和错误码，不回显用户路径或配置内容。

`install` 默认自动发现并在一个首装事务中配置全部可用宿主；`--host` 仍可用于显式单宿主操作。多宿主同版本重跑会完整复验且不改状态；跨版本由统一恢复标记协调所有候选资产、Claude catalog 和插件 activation，全部就绪后只切一次 active pointer、只提交一次完整 install-state。最终提交前失败会全局回滚，进程中断后的可证明旧/候选现场会在下一次自动 install 收敛。

## 当前限制

正式 CLI 在安装前会递归收紧用户级 runtime：POSIX 校验当前 owner 并使用目录 `0700`/文件 `0600`，Windows 仅保留当前 SID 的继承 ACL；版本、状态、恢复证据、备份和私有 KooCLI 均位于该边界内，卸载读取状态前会再次复核。稳定 launcher 会直接从已完成 SHA-256 校验的内存字节加载主 CLI；审批 launcher 也会经私有 stdin 把已验签 companion 入口和七份契约文本交给固定 bootstrap，父子分别从同一批已验签文本编译 verifier/signer，入口与审批 schema 都不会在校验后按路径二次读取。

OpenCode 与码道现已支持跨版本受管升级：固定 stable launcher 配置不重写，最初的用户配置备份保持不变；Canonical Skill 仅在本次安装拥有且 hash 未漂移时替换。严格恢复标记可在进程强制终止后收敛旧/候选 Skill、active pointer 和 install-state，未知 quarantine 内容保持 fail closed。

安全凭证生命周期现已实现：独立用户目录、严格 schema、原子 CAS 更新/删除、POSIX `0600`、Windows 当前用户 ACL、每次 set 更新 generation、非回显录入、只读账号身份校验，以及不含密钥的 status 输出。本地 OBS provider 使用最长 900 秒的进程内 session，并校验 generation、route token、provider instance 和账号漂移；其固定签名请求不接受用户 endpoint，XML 响应经过大小和主动内容限制。

当前工程已包含契约注册表、CLI doctor、stdio MCP 三工具服务、静态开发态 capability catalog、最小 Router `preview/execute` 状态机、受信审批 companion 核心，以及完整安装清单、版本化运行时物化和稳定 launcher。四宿主真实用户级路径与原生 MCP 形态已固化为内置模板；单一 Canonical Skill 会在构建时生成 Codex/Claude 插件与通用 Skills 产物，两类插件 manifest 均已接入实际校验。宿主配置事务已支持严格 JSON、保留注释的 JSONC、同名冲突、权限受限备份、原子替换和基于安装前后 hash 的安全回滚；插件/Skills 资产也已支持安装清单复验、staging 渲染、完整 tree hash、幂等冲突和 quarantine 安全回滚。Codex 插件已按个人 marketplace 约定绑定到 `~/plugins/huaweicloud-mate`；marketplace 严格 JSON 事务、结构化 CLI add/list/remove 激活、注册与启用 ownership 证据、install-state 绑定和首装依赖安全回滚已完成。`install --host codex` 现已把运行时物化、宿主验证和无云审批探针接成首装入口；`uninstall --host codex` 会重新绑定固定路径、预检 identity/hash，只撤销本次拥有且未漂移的 activation、marketplace、asset 和状态，同时保留 runtime 与凭证。最小 install-state 已能严格绑定 runtime/config/assets/registration/activation 证据，支持清单复验、幂等/CAS 写入和 hash 安全回滚。开发态 reference executor 只返回确定性本地数据，不读取凭证、不访问华为云；Router 在结果进入 Agent 前执行 output schema、大小、JSON Pointer 敏感路径脱敏和未声明凭证材料兜底拒绝。`doctor --approval-probe` 可执行一次无云副作用的真实交互探测；审批只需点击批准或拒绝，不要求输入密码。

开发服务可通过 `npm run mcp` 启动。三工具 Draft 已冻结危险流程：第二次 `execute` 只提交原输入和 `previewId`，Router 内部完成浏览器审批、回执验签、凭证复核与原子 dispatch；不增加第四个 Tool，也不要求密码。稳定 launcher 已能从固定版本目录启动自包含 Router，并在启动前校验完整制品清单；四宿主提交前还会真实启动该 Router、完成 MCP 初始化并严格核对三个冻结工具。真实 stdio Router 已写入权限受限的本地 JSONL 日志，只保留固定元数据和参数/结果摘要，不记录凭证、session、回执或正文。Codex 和 Claude 单宿主现已具备首装、同版本幂等复核、跨版本受管升级、安全卸载和严格的升级中断恢复门禁；候选 runtime 不提前激活，常规失败会恢复旧 state/pointer/asset/catalog/activation，进程强制终止或 Claude CLI 结果未知后的可证明现场会在下一次 install 前保守收敛。Claude Windows npm shim 只在能严格解析到同目录树内同名原生可执行文件时被接受，runner 始终不启用 shell。OpenCode 和码道已支持配置、Skill、状态及卸载事务。KooCLI 已完成预装优先选择、五平台 `7.2.12` 官方制品/SHA-256 绑定、安全解包、私有版本原子安装、hash 复核、doctor、固定映射 Adapter，以及用户明确授权的无配置 argv invoker；它只在 dispatch 前读取当前 generation，使用绝对路径、`shell=false`、最小环境、零 KooCLI 重试和有界 JSON 输出，不创建 profile。官方 `latest` 对象变化时旧插件会摘要失配，不会静默升级。当前 catalog 已加入 `huaweicloud.ecs.server.list.v1`，固定 mapping、敏感读取审批和裁剪输出的无云闭环已完成；仍需 KooCLI 元数据可用性与最小权限真实账号验收。五平台 CI、npm pack/许可/漏洞/secret、SBOM、provenance 和受保护手动 npm workflow 已建立；`pack:check` 还会真实生成 tarball、在隔离目录离线安装，并通过安装后的 bin 运行版本与零 deferred 契约 Doctor。当前 private/development 身份会主动阻止发布。真实产品 MCP 已按用户决策后置，不再是首版发布门禁；当前仍需完成码道真实会话、四宿主隔离、真实最小权限账号验收和 npm 发布身份。
