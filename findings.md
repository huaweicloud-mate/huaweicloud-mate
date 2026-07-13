# 调研与共识记录

## 开源首版简化方向（已收敛，2026-07-13）
- 用户认为 Proposed v0.2 过重，新增首版约束：以开源形式发布，并据此重新确定最小核心。
- 原 v0.2 继续作为能力与安全边界基线，不在澄清前直接改写正式架构。
- 当前复杂度主要来自五组机制：中心签名 Registry、设备 mTLS 与凭证控制面、统一 Capability/Policy/Audit、双执行器协调、四宿主完整安装与回滚。
- 对纯开源首版而言，任何依赖华为云内部 KMS/HSM、证书签发、Provider 审核/on-call 的路径都不是仓库本身可独立交付的能力，需要确认是移出首版、作为可插拔接口保留，还是仍由官方托管服务配套。
- 待验证的精简候选是：单一本地 stdio Core、静态受信配置、Canonical Skills、KooCLI 受控适配、最薄宿主安装；远程产品 MCP、动态 Registry、凭证委托控制面和企业治理作为可选或后续能力。

### 当前重量来源与候选裁剪
- 最大外部依赖：签名 Registry、设备证书签发、Provider KMS/HSM、公网凭证控制面、安全审批和产品 on-call。这些更像“官方托管服务版”能力，不适合作为纯开源仓库首版的前置条件。
- 最大本地工程量：四套 Adapter 的 install/update/repair/uninstall 事务、三平台 Secret Store、KooCLI 下载/版本/回滚、Capability/Policy/Audit/双执行器的一致语义。
- 如果首版只做读操作，可移除 `cloud_action_plan`、风险分级确认、幂等/结果未知处理和大部分审计，仅保留输入白名单、输出脱敏和超时。
- 如果首版只以 KooCLI 执行，可移除远程 Provider Client、credential session、动态 Registry、Provider Manifest/conformance 和双执行器协调；产品 MCP 作为后续插件点保留接口即可。
- 如果首版允许用户预先安装并配置 KooCLI，可进一步移除二进制下载、跨平台校验、私有版本目录与凭证管理；代价是一键安装体验变弱。
- 如果四类宿主必须同时首发，仍可把 Adapter SPI 简化为四份声明式配置模板，不先实现 receipt、drift、repair 和原子回滚框架。

### 精简核心候选（等待用户确认）
```text
Agent 宿主
  -> MCP 配置 + Canonical Skills
  -> 本地 stdio Router
  -> 静态能力清单
  -> 受控 KooCLI 调用
```
- 必留安全底线候选：禁止任意代码执行、禁止 Agent 指定 endpoint/命令/凭证、参数数组启动、超时/输出上限、基础脱敏、副作用失败不自动重放。
- 首版工具面可从 5 个降到 3 个：`cloud_capabilities_search`、`cloud_capability_describe`、`cloud_action_execute`；只有允许副作用操作时才恢复 `cloud_action_plan`。
- 远程产品 MCP 可先定义扩展接口但不实现运行链路；等至少有一个公开可用 Provider 和官方托管安全服务后再加入。

### 用户第一轮简化答复
- 核心成果：用户可以直接指挥 Agent 创建、修改并配置华为云资源，例如创建并配置 ECS、创建并配置 OBS。
- 用户范围：个人、企业、华为内部等全部覆盖，不能通过缩小用户群减重。
- 产品 MCP：首发时会有公开产品 MCP，但具体产品范围未定，预计覆盖核心常用云服务。
- 操作范围：包含创建、修改、删除、IAM、网络和计费，不能以只读首版规避安全闭环。
- Agent 范围：OpenCode、Claude Code、Codex、华为云码道全部首发。
- KooCLI：插件必须自动下载安装，同时兼容用户预先安装的 KooCLI。
- 凭证体验：用户只需提供 AK/SK；具体本地存储和远程使用方式仍需继续简化。
- 固定小工具面：search/describe/execute 是首版核心差异，必须保留。
- Provider 范围：只支持内置能力，不开放社区自定义 MCP。
- 安装体验：必须自动完成宿主配置，不接受仅输出配置片段。

### 基于答复的收敛判断
- 不可裁剪：四宿主自动安装、KooCLI 自动安装/复用、固定小工具面、全风险操作、内置远程产品 MCP 接入。
- 可以裁剪：动态中心 Registry、社区 Provider SDK、复杂 Adapter capability SPI、完整 repair/drift 框架、企业策略分发、分布式审计协议、Provider 自助接入/conformance 平台。
- 工具面可固定为 3 个：`search`、`describe`、`execute`。危险操作的预览与确认可以合并进 `execute` 的两阶段协议，而不额外暴露 `plan` 工具。
- 内置 Provider 清单可随 npm 版本静态发布；新增、变更或禁用 Provider 通过插件发版完成，从而移除动态 Registry、签名、缓存、吊销和 last-known-good 机制。
- 最大剩余不确定性是 AK/SK：本地 KooCLI 可由 Core 注入凭证，但远程产品 MCP 若直接执行云 API，必须在“远程委托 AK/SK、远程只规划本地执行、Provider 自带认证”之间明确一种契约。

### 用户第二轮简化答复
- 产品 MCP 尚未定义用户鉴权协议；首版直接使用 AK/SK，允许 AK/SK 离开本机。
- 路由接受简化为：产品 MCP 支持时默认 MCP，否则 KooCLI；用户可明确指定；执行失败后不自动切换。
- 接受把危险操作预览与一次性确认令牌合并进 `execute` 两阶段协议，从而保持 3 个固定工具。
- 接受首次使用时输入一次 AK/SK，并要求后续可以修改；用户询问是否允许把 AK/SK 放入配置文件。
- 内置 Provider 随 npm 静态发布，不需要服务端紧急禁用。
- 用户担心插件私有固定 KooCLI 版本不能保证正常使用，需要明确兼容性探测和安装后自检。
- 接受声明式四宿主模板，以及 `install`、`doctor`、`uninstall` 的精简生命周期；不实现独立 repair 和复杂 drift 检测。
- 接受仅保留本地 JSONL 日志，不上传遥测、不实现企业策略中心和分布式审计。
- 原环境限制继续成立：不支持离线、HTTP/HTTPS 代理、无桌面 Keyring 的 headless Linux。

### 凭证与 KooCLI 的当前建议
- AK/SK 修改应通过 `hcloud-agent auth set` 覆盖当前凭证或 `auth rotate` 完成；修改后立即撤销旧远程 session，新的执行使用新凭证。
- 主配置文件只保存非敏感设置和 credential reference。若允许明文文件，应限定在用户目录专用 credentials 文件、设置最小文件权限/ACL、明确警告且禁止 workspace 路径；不应把 AK/SK 混入普通 JSON 配置或 Agent 配置。
- 固定 KooCLI 版本不能保证网络、凭证和所有云 API 永远可用，但能保证插件与 CLI 参数/输出契约可复现。安装器必须执行 SHA-256、`version`、最小只读 smoke/doctor；失败则中止，不宣称安装成功。
- 预装 KooCLI 只有在版本落入插件兼容范围且 doctor 通过时才复用，否则安装并使用插件私有固定版本，不修改用户的系统 KooCLI。

### 用户第三轮简化答复与最终收敛
- 接受产品 MCP 在同域 HTTPS credential session 中接收 AK/SK，仅在内存保存最长 15 分钟并返回 opaque session ID。
- 接受删除独立凭证控制面、设备 mTLS、应用层信封加密和 KMS/HSM 依赖；信任边界收敛为“内置官方产品 MCP 可以接触用户明文 AK/SK”。
- 接受首版默认使用用户目录下权限受限的独立 credentials 文件，不实现跨平台 Keyring。
- 接受首版只维护一个当前账号；`auth set` 覆盖更新 AK/SK，并使所有旧远程 session 立即失效。
- 对精简首版的需求理解达到约 93%，已经超过 90% 目标；剩余产品清单和验收场景属于实施输入，不阻塞架构定稿。

### Proposed v0.3-lite 核心模块
```text
公共 npm Installer
  -> 四宿主声明式配置模板 + Canonical Skills
  -> 本地 stdio Tool Router（search / describe / execute）
       -> 内置产品 MCP Client（HTTPS AK/SK 短会话）
       -> 受控 KooCLI Adapter（预装复用或私有固定版本）

本地共享：静态能力清单、单账号 credentials 文件、最小风险门禁、JSONL 日志
```
- 不再设计通用 Adapter SPI 或多 package 控制平面；首版可以单一 npm package 组织实现。
- 不再设计独立 `Policy Engine`；保留 Router 内置的风险分类和一次性确认令牌门禁。
- 不再设计动态 Provider Registry；内置 endpoint、产品映射和版本兼容信息随 npm 发版。
- 不再设计独立审计协议；只记录本地脱敏执行摘要和产品/KooCLI request ID。

## 用户给定目标
- 构建华为云 Agent 插件，集成 MCP、Skills、KooCLI，让开发者通过 Agent 操作华为云各类资源。
- 首版至少支持 OpenCode、Claude Code、Codex、华为云码道，并为后续 Agent 预留扩展能力。
- 各产品部后续提供基于华为云 OpenAPI 封装的 MCP。
- 借鉴 MetaMCP，以少量 meta-tools 按需发现和调用下游 MCP，避免一次性把全量工具放入 Agent 上下文。
- 安装插件时一并安装或确保可用 KooCLI。

## 用户确认的产品约束（2026-07-13）
- 安装体验：类似 npm 命令一键安装。
- 首版 surface：OpenCode、Claude Code、Codex、华为云码道的本地 CLI/桌面开发环境。
- PoC 定位：`D:\CodeSpace\AI-Plugin` 只作预研参考，正式项目重新设计与实现。
- MetaMCP：不直接依赖，只借鉴 namespace、catalog、middleware。
- 产品 MCP：华为云托管的 Streamable HTTP 服务，由中心注册表统一发布。
- KooCLI：与产品 MCP 同等优先，Agent 可按任务自行选择。
- 凭证：首版使用 AK/SK。
- 安全默认：读默认允许；创建/修改、删除/IAM/网络等操作由统一策略授权或确认，并记录审计。
- 平台矩阵：与 KooCLI 一致，即 Windows amd64、Linux amd64/arm64、macOS amd64/arm64。
- 首版产品：OBS、ECS、VPC、IAM。

## 用户确认的第二轮约束（2026-07-13）
- 发行：公共 npm，假设 Node.js 已安装；默认 user-scope 全局装配。
- 凭证：选择方案 B，产品 MCP 通过独立受保护控制面获得永久 AK/SK，只允许短期内存使用。
- 网络：产品 MCP 为公网 endpoint；不支持企业 HTTP/HTTPS 代理。
- 覆盖：产品 MCP 未上线时允许 KooCLI 先满足该产品首版覆盖。
- 路由：低风险 read 可自动选择；副作用动作固定执行器且失败不自动切换。
- KooCLI：原生 `hcloud` 不进入 PATH，只使用插件私有受控调用。
- Registry：插件平台团队负责 Provider Manifest 审核、签名、发布与吊销。
- 环境：不支持离线，不支持 headless Linux 无 Keyring 场景。
- 基于这些回答，目标理解度达到约 95%，可以进入架构评审和实现准备。

## PoC 只读审阅新增发现
- PoC 确实是 OBS-only Demo，未实现 Claude Code、码道、KooCLI 安装、中心 Provider Registry 或宿主无关 installer。
- PoC 同时出现 `metatool-ai/metamcp`、`@mentu/metamcp` 和自研 `metamcp-wrapper.ts` 三个不同概念/实现；正式项目必须完全去除此身份混淆。
- PoC 的五个紧凑工具由 Demo 自己实现，并非 MetaMCP 上游提供：`mcp_discover`、`mcp_describe_tool`、`mcp_provision`、`mcp_call`、`mcp_execute`。
- PoC 中 `mcp_provision` 只是“根据意图解析本地 OBS 工具”的兼容占位；另一版预研文档又把它定义为“为 target 建立/续期受控产品会话”。两种含义都不是 MetaMCP 的稳定上游语义。
- 结论：正式接口不应保留语义模糊的 `mcp_provision`。若需要远端凭证会话，应命名为 `provider_session_open/refresh` 或在网关内部完成；若只是查找工具，应由 `discover` 完成。
- PoC 已提出远程 MCP 与本地 KooCLI 同账号绑定、平台原生 secret store、固定小工具面等有价值思路，可作为 ADR 输入，但实现代码不直接继承。
- PoC 的 `mcp_execute` 接收任意 JavaScript 并在 `node:vm` 中组合调用；这会模糊审批、资源预算和静态审计边界，正式架构应删除。组合工作流应由 Skill 分步调用或由经过注册/审计的 workflow definition 承载。
- PoC 旧路由规则规定“产品 MCP 优先，KooCLI 回退”，与用户最新确认的“同等优先、Agent 自行选择”不一致。正式方案应让两条路径都进入统一 capability catalog，由 Skill 给出选择依据，但不硬编码 MCP 优先级。
- 无论 Agent 选择哪条执行路径，写/删除/付费操作失败后都不得自动换另一条路径重试，否则可能造成重复副作用；这条 PoC 规则值得保留。
- PoC 的凭证委托草案采用独立 mTLS 控制面把 AK/SK 交给远程产品 MCP，内存短会话保存并进行账号身份校验。边界定义较完整，但“向远端传原始 SK”是重大安全/合规决策，不能未经平台安全团队确认直接成为正式架构。
- 推荐优先评估：本地使用 AK/SK 换取短期、受限的 IAM 凭证/Token，再向产品 MCP 委托短期凭证；只有华为云身份体系无法满足时，才考虑 PoC 的原始 AK/SK 内存委托协议。

## IAM 临时凭证核验
- 华为云官方推荐 STS 临时安全凭证：临时 AK/SK + `security_token`，短期有效且不持久化，调用时通过 `X-Security-Token` 携带。
- STS `AssumeAgency` 需要已有 IAM 委托/信任配置；不能假设仅凭用户永久 AK/SK 就能在零配置条件下获得最小权限临时凭证。
- 旧版/特定 API 的临时 policy 限制当前明确只有 OBS 识别；ECS/VPC/IAM 不能依赖同一 policy 参数实现统一的操作级最小权限。
- KooCLI 官方支持永久 AK/SK、临时 AK/SK + SecurityToken、ECS Agency 和 SSO profile；首版虽然由用户指定 AK/SK，内部 target 模型仍应预留 `securityToken` 和未来认证模式。
- 因而远程产品 MCP 的凭证方案仍是正式架构唯一的高风险未决项：
  1. 要求用户预先创建 IAM Agency，由本地 Core 用永久 AK/SK 换取 STS 临时凭证后委托；
  2. 由独立受保护控制面把永久 AK/SK 交给产品 MCP 的短期内存会话；
  3. 设计本地签名/执行代理，使产品 MCP 不接触凭证，但会显著改变产品 MCP 的实现契约。
- 当前推荐以方案 1 为生产目标；若“一键安装后只填 AK/SK 即可工作”是硬要求，则必须由平台安全团队在方案 2 与方案 3 之间做正式安全评审。

## Tool Router MCP v0.1 候选固定工具面
- `cloud_capabilities_search`：跨产品 MCP 与 KooCLI catalog 搜索能力，结果只含轻量摘要、执行后端和风险级别。
- `cloud_capability_describe`：按 capability ID 返回完整 schema、目标范围、所需 region/project、风险和可用后端。
- `cloud_action_plan`：为写/删/付费动作生成短期 plan，固定目标、后端、参数摘要和幂等信息。
- `cloud_action_execute`：执行已描述的读操作或已确认 plan；内部路由到选定产品 MCP 或 KooCLI adapter。
- `cloud_targets_status`：返回 target、凭证就绪、provider 健康与账号绑定状态，不返回任何密钥。
- 不保留 `mcp_provision` 与任意代码型 `mcp_execute`。

## 草图解读
- 下游：OpenCode、Codex 等 Agent，每种 Agent 对应一个 adapter。
- 中心：`mate-core`，包含 `mcp-meta-tools`、`mcp-tools-catalog` 和 `assembly-installer`。
- 上游：多个产品 MCP server，经 catalog 接入 core。
- 统一暴露的候选 meta-tools：`mcp_discovery`、`mcp_describe`、`mcp_call`、`mcp_provision`。
- 随安装交付：KooCLI、Skills 及后续其他资产。

## 初步观察
- 草图把“运行时路由”和“安装期装配”画在同一个 core 中，后续需要明确进程边界和生命周期。
- `mcp_provision` 语义不清：可能是动态安装/启动 MCP，也可能是云资源 provisioning；必须消除歧义。
- 产品 MCP 的运行形态尚不明确：本地 stdio、远端 HTTP/SSE、托管服务，或混合模式。
- 四类 Agent 对“插件、Skill、MCP”的原生概念和配置生命周期可能不同，adapter 应基于能力协商，而不是只做文件复制。
- KooCLI 的安装许可、二进制再分发、操作系统/CPU 支持、升级和校验策略是架构前置条件。

## 已核验事实（第一轮）

### MetaMCP
- MetaMCP 官方仓库将其定义为 MCP proxy/aggregator/orchestrator/middleware/gateway；可把多个 server 组织到 namespace，并以一个 endpoint 暴露。
- namespace 可在 server/tool 级启停、覆盖 tool 元数据、附加 annotations，并通过 middleware 过滤 inactive tools。
- 重要差异：其公开时序图仍会对所有已连接 server 执行 `list_tools`，聚合后把工具列表返回客户端；这并不等于草图中只暴露 `discovery/describe/call` 三四个 meta-tools。因此“借鉴 MetaMCP”需要明确是借鉴治理/聚合模型，还是要开发一种真正的延迟工具解析协议。
- MetaMCP endpoint 原生是远端 SSE / Streamable HTTP / OpenAPI；stdio-only 客户端需要本地 proxy。我们的跨 Agent 首版更适合由本地 stdio gateway 作为最低公共分母，内部再连接本地或远端产品 MCP。

### OpenCode
- 原生支持本地 MCP（command + environment）和远端 MCP（URL、headers、OAuth）；可按全局/Agent 粒度启停工具。
- 原生 Skills 按需加载，仅先暴露名称和描述；支持 `.opencode/skills`、`.claude/skills`、`.agents/skills` 等路径。
- 原生插件是 JS/TS 或 npm 包，可注册 custom tools 和 lifecycle hooks。
- 架构含义：OpenCode adapter 可做深度集成，但首版仍应优先走 MCP + Skills 这个跨 Agent 公共面，避免把业务逻辑绑在 OpenCode 插件 API。

### 华为云码道
- Agent Space 支持 stdio、SSE、Streamable HTTP MCP；CLI 支持本地/远端 MCP，且兼容 Claude Code MCP 配置格式。
- 码道 CLI 项目级 Claude 兼容配置路径是 `.codeartsdoer/mcp/mcp_settings.json`。
- 码道提供 MCP 市场和 MCP 管理能力；官方建议同时开启数量受控，说明上下文与资源占用确实是产品约束。
- 码道还有 IDE 插件、CLI、Agent Space 多种形态，三者安装面和能力并不完全相同，不能把“支持码道”当成单一 adapter，必须确认首版目标 surface。
- 码道 CLI 的 Skills 结构与 Agent Skills 约定高度一致：必需 `SKILL.md` + YAML `name/description`，可带 `scripts/references/assets`；项目路径 `.codeartsdoer/skills`，个人路径 `~/.codeartsdoer/skills`。
- 码道 CLI 还有 JS/TS plugin hooks，可在工具执行、消息、权限等生命周期注入逻辑，并能在启动时安装 `package.json` 依赖；这属于增强集成面，不宜成为首版公共能力的必要条件。

### KooCLI
- KooCLI 是面向 API Explorer 中云服务 API 的单文件 CLI，可直接管理云资源；其能力范围与产品 MCP 会存在交叠，应定义清晰的调用优先级。
- 官方当前提供 Windows amd64、Linux amd64/arm64、macOS amd64/arm64 包，并为每个包提供 SHA-256 校验文件；下载解压即可运行，命令名为 `hcloud`/`hcloud.exe`。
- Linux 官方一键安装默认写 `/usr/local/hcloud` 与 `/usr/local/bin`，通常涉及提权；插件安装器不应默认依赖此全局路径。更稳妥候选是把经校验的固定版本二进制放到插件私有目录，并由 wrapper 解析路径。
- 尚需产品/法务确认是否允许把 KooCLI 二进制直接随插件再分发；技术上也可选择安装时从华为云官方地址下载并校验，以避免仓库内携带多平台大二进制。

### 跨 Agent Skills 兼容性
- OpenCode 与码道 CLI 当前都采用 Agent Skills 风格目录和 `SKILL.md` 基本元数据，说明可以维护 canonical skill source，再由 adapter 生成/链接到各自路径。
- 仍需核验 Claude Code 与 Codex 的字段、路径和插件打包差异，不能只凭格式相似假设完全兼容。

### Claude Code
- Claude Code 原生插件可把 Skills、hooks、agents、MCP servers 等作为一个安装单元，插件身份清单位于 `.claude-plugin/plugin.json`，并可通过 `.claude-plugin/marketplace.json` 目录分发。
- 安装后插件被复制到版本化本地 cache；插件不可依赖包目录外的相对文件。这意味着跨 Agent 发行包可以共享源代码，但 Claude adapter 必须生成一个自包含的 plugin artifact。
- 插件 MCP 在启用后随 session 自动连接，可用 `${CLAUDE_PLUGIN_ROOT}` 指向随插件交付的本地 gateway/KooCLI wrapper，也有 `${CLAUDE_PLUGIN_DATA}` 持久化状态。
- Claude Code 支持 stdio、HTTP、已弃用的 SSE；远端建议 HTTP。MCP 支持 local/project/user/plugin 多层 scope，项目 MCP 首次使用有审批。
- Claude Code 当前默认支持 tool search，MCP 可用 `list_changed` 动态更新工具。该原生能力可能已部分解决工具上下文膨胀，因此我们的 meta-tools 方案必须与各 Agent 原生 tool search 做兼容性和收益对比，不能假设所有客户端都一次性注入全量 schema。

### Codex 当前环境现状
- 本机已安装一个不属于当前仓库的本地原型 `huaweicloud-obs 0.1.0`，plugin manifest 位于 `.codex-plugin/plugin.json`，引用 `skills/` 与 `.mcp.json`；这验证了 Codex plugin 可以把 Skills 和 MCP 配置组成单一安装单元。
- 原型的 meta-tools 约定为 `mcp_discover`、`mcp_describe_tool` 和间接调用，且 child server 名为 `huaweicloud-obs`；说明草图可能来源于已做过的 OBS PoC。
- 当前 `.mcp.json` 把 MCP wrapper 的命令硬编码到 `D:\CodeSpace\AI-Plugin\...`，无法跨机器发行；正式架构必须使用插件根目录变量、随包 wrapper、私有 runtime 路径或稳定 PATH launcher。
- 当前 `.mcp.json` 直接设置 `HUAWEICLOUD_OBS_ENABLE_WRITE=true`，而 Skill 文案又称写操作默认关闭，存在配置与策略漂移。正式架构应把安全策略集中到 policy engine/installer config，不能散落在 Skill 文案和 adapter 文件里。
- 是否允许继续读取和复用 `D:\CodeSpace\AI-Plugin` 的 PoC 源码尚未得到用户确认，目前只把已安装 manifest/Skill 当作环境事实。

## 新增关键风险
- “上下文爆炸”在不同 Agent 版本上的表现不一致：Claude Code 已有默认 tool search，OpenCode/码道也有自己的按需或启停机制。需要用统一基准测试证明额外 `mcp_call` 间接层的价值，否则会牺牲原生工具可见性、权限提示粒度和类型体验。
- MCP tool annotations（如只读/破坏性提示）如果被封装进通用 `mcp_call`，客户端可能看不到目标工具的原生风险元数据。core 必须保留或重新实现审批策略，不能只是透明代理。

## 关键设计修正候选
- 将草图中的 `mcp-meta-tools` 暂定为本项目自研的“Tool Router MCP”，不要直接声称 MetaMCP 已实现相同的按需发现模型。
- adapter 应按 surface/capability 建模，例如 `mcp.local_stdio`、`mcp.remote_http`、`skills.agent_skills`、`native_plugin`、`config.scope.project/global`，而不是只按品牌名称建模。

## 待核验来源
- MetaMCP GitHub 仓库与文档
- 华为云 KooCLI 官方文档
- 华为云 API Explorer / OpenAPI 规范
- OpenCode、Claude Code、Codex、华为云码道官方扩展文档

## 待用户确认
- 产品和发行形态
- 支持的 OS / CPU / 企业网络环境
- 凭证来源、权限模型、审计与危险操作确认
- 产品 MCP 的交付、发现、签名、部署与版本治理
- KooCLI 的定位、集成方式和再分发许可
- 首版业务范围与验收场景
- 本机现存 `D:\CodeSpace\AI-Plugin` 与 `huaweicloud-obs` Codex 原型是否属于本项目可复用的前置成果
