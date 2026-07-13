# 华为云 Agent 插件技术架构共创计划

## 目标
与用户共同完成一个可落地、可扩展的华为云 Agent 插件技术架构，使插件统一集成 MCP、Skills 与 KooCLI，首版支持 OpenCode、Claude Code、Codex、华为云码道，并能够低成本扩展到其他 Agent。

## 当前状态
- 当前阶段：阶段 5 已完成；M0 契约冻结进行中，尚未授权应用工程实现
- 理解度目标：达到并经用户确认至少 90%
- 当前理解度：原 Proposed v0.2 约 95%；对新的开源精简首版约 93%
- 仓库状态：M0 文档与 schema 已整合到 `dev_explore`；旧 OBS 原型已退役，尚无应用工程代码

## 阶段

### 阶段 1：事实核验与问题域建模（已完成）
- [x] 检查仓库状态与用户草图
- [x] 核验 MetaMCP 的工具发现/调用模型与部署方式
- [x] 核验 KooCLI 的安装、平台、认证与调用约束
- [x] 核验首版四类 Agent 的插件/MCP/Skill 扩展机制
- [x] 建立术语、边界、关键假设与风险清单

### 阶段 2：需求澄清与架构决策（已完成）
- [x] 与用户确认产品形态、发行方式、运行环境与安全边界
- [x] 与用户确认 MCP 产品接入规范和 catalog 生命周期
- [x] 与用户确认凭证、权限、审计与高危操作策略
- [x] 与用户确认离线、代理、升级、兼容性和企业治理要求
- [x] 将关键决策记录为 ADR

### 阶段 3：总体架构设计（已完成）
- [x] 定义逻辑架构、运行时架构、部署架构与信任边界
- [x] 定义 core、adapter、installer、catalog、meta-tools、skills、koocli 模块职责
- [x] 定义跨 Agent 的能力模型和 adapter SPI
- [x] 定义 MCP 注册、发现、描述、调用、授权和错误模型
- [x] 定义 KooCLI 的打包/引导安装与版本管理方案

### 阶段 4：工程与交付设计（已完成）
- [x] 定义 monorepo 目录、技术栈、构建、测试和发布流水线
- [x] 定义插件清单、配置格式、版本兼容矩阵与升级机制
- [x] 定义可观测性、安全测试、供应链安全与回滚方案
- [x] 规划 MVP、里程碑和产品部 MCP 接入路径

### 阶段 5：评审与定稿（已完成）
- [x] 用关键场景和故障场景验证架构
- [x] 输出总体架构文档和可执行的首版实施计划
- [x] 澄清开源首版的核心用户、核心闭环、服务依赖与安全责任边界
- [x] 区分首版必需核心、可选能力和后续企业级能力
- [x] 输出精简方案 Proposed v0.3-lite
- [x] 用户完成 Proposed v0.3-lite 文档终审并要求提交 Git

### M0：精简契约冻结（进行中）
- [x] 用户确认阶段 5 后续审查建议
- [x] 新增 ADR-0008，补充可信审批、session 生命周期、复合风险、稳定运行路径和兼容握手
- [x] 创建 Router、Capability、Provider、credential session、approval、宿主模板和 KooCLI Draft schema
- [x] 创建正反例与状态机测试向量
- [x] 同步技术、安全、Provider、宿主、路线图和线程交接文档
- [ ] 使用独立 JSON Schema Draft 2020-12 校验器验证 schema 与测试向量
- [ ] 绑定四宿主可信审批 issuer
- [ ] 绑定首发产品 MCP、endpoint、版本范围和 schema digest
- [ ] 绑定 KooCLI 固定版本、兼容范围、URL 和 SHA-256
- [ ] 冻结 3～5 个真实端到端验收场景

M0 未完成前不得创建 TypeScript 应用工程；本轮仅授权在 `dev_explore` 进行文档整合、旧原型清理和本地提交，未经用户明确授权不得推送 Git。

精简首版已无阻塞性需求问题。后续仍需在实施前补齐具体首发产品 MCP 清单、endpoint、KooCLI 兼容版本和 3～5 个端到端验收场景，但这些不改变核心架构。

## 已确认的 Proposed v0.3-lite 覆盖决策
1. 固定三个 Router tools：search、describe、execute；危险操作由 execute 内部执行两阶段确认。
2. 内置产品 MCP 静态随 npm 发布；产品 MCP 优先，未覆盖时使用 KooCLI；执行开始后不自动切换。
3. 产品 MCP 通过同域 HTTPS credential session 接收 AK/SK，内存保存最长 15 分钟；不建设独立控制面、设备 mTLS、信封加密或 KMS/HSM 链路。
4. 首版使用用户目录下权限受限的独立 credentials 文件，只支持一个当前账号，可覆盖更新。
5. KooCLI 优先复用兼容且 doctor 通过的预装版本，否则安装插件私有固定版本并校验。
6. 四宿主使用声明式模板自动安装；只提供 install、doctor、uninstall，保留必要备份与失败回滚。
7. 只保留本地 JSONL 日志，不提供动态 Registry、社区 Provider、企业策略中心、分布式审计、复杂 Adapter SPI、repair 或 drift 框架。

## 当前 Proposed v0.3-lite 基线
1. 单一 npm package 交付 Installer、Router、静态能力清单、产品 MCP Client、KooCLI Adapter、宿主模板和 Skills。
2. Agent 只看到 search、describe、execute；危险操作由 execute 两阶段确认。
3. 产品 MCP 静态内置并默认优先，未覆盖时在执行前选择 KooCLI，执行开始后不自动切换。
4. AK/SK 使用单账号权限受限 credentials 文件，并通过同域 HTTPS 进入官方产品 MCP 的短期内存 session。
5. 四宿主使用声明式模板；首版不提供动态 Registry、通用 SPI、独立 Policy Engine 或企业治理平台。

## 历史决策（2026-07-13 第一轮，冲突项由 ADR-0007 覆盖）
1. 采用类似 npm 命令的一键安装体验。
2. 首版支持 OpenCode、Claude Code、Codex、华为云码道的本地 CLI/桌面开发环境。
3. `D:\CodeSpace\AI-Plugin` 仅作为 MCP 预研 Demo 参考，不作为可落地基线。
4. 不直接依赖 MetaMCP；只参考 namespace、catalog、middleware，自研轻量 Tool Router MCP。
5. 产品 MCP 由华为云托管为 Streamable HTTP 服务，通过中心注册表统一发布。
6. KooCLI 与产品 MCP 同等作为云资源操作路径，由 Agent 根据场景选择。
7. 首版采用 AK/SK；查询默认允许，写/删等按统一策略确认并审计。
8. OS/CPU 支持矩阵跟随 KooCLI；首版覆盖 OBS、ECS、VPC、IAM。

## 历史决策（2026-07-13 第二轮，冲突项由 ADR-0007 覆盖）
1. 发布到公共 npm，假设用户已安装 Node.js。
2. 默认用户级全局安装。
3. 远程产品 MCP 使用永久 AK/SK 的独立 mTLS 短期内存委托方案。
4. 产品 MCP 使用公网地址；首版不支持 HTTP/HTTPS 代理。
5. 产品 MCP 未上线时可由 KooCLI 先满足产品覆盖。
6. 低风险 read 允许自动选择；副作用动作锁定 executor 且不自动切换。
7. 原生 `hcloud` 保持插件私有，不加入 PATH。
8. 插件平台团队负责审核、签名、发布、吊销 Provider Manifest。
9. 首版不支持离线环境和没有桌面 Keyring 的 headless Linux。

## 待交付物
- `docs/线程交接说明.md`：新线程继承所需的目标、决策、状态与下一步
- `docs/技术架构.md`：总体技术架构
- `docs/架构决策/`：关键架构决策记录
- `docs/智能体适配器接口规范.md`：Agent adapter 能力与接口规范
- `docs/产品MCP接入规范.md`：产品 MCP 接入规范
- `docs/安全架构.md`：凭证、授权、审计与供应链边界
- `docs/首版实施路线图.md`：MVP 范围与实施里程碑

## 错误记录
| 日期 | 错误 | 处理 |
|---|---|---|
| 2026-07-13 | Codex manual helper 在代理环境返回 `Manual response is missing x-content-sha256` | 不采用未校验内容；改用 OpenAI 官方 Docs MCP，必要时再限定官方域名检索 |
| 2026-07-13 | 当前会话未加载 OpenAI Docs MCP，执行 `codex mcp add` 时 `codex.exe` 被系统拒绝访问 | 不绕过系统策略；本轮改用仅限 `developers.openai.com` 的官方网页检索，后续新会话再验证 MCP 是否可用 |
| 2026-07-13 | 批量直连 OpenAI/Anthropic 文档页面超过 90 秒无返回 | 终止挂起请求，改用窄范围官方域名检索；Anthropic 文档已获取，Codex 继续以官方搜索 + 当前环境事实交叉验证 |
| 2026-07-13 | `rg --files` 未找到 Codex plugin manifest 且无输出 | 改用 PowerShell 递归枚举，成功定位本机已安装 plugin manifests |
| 2026-07-13 | 并行文档校验中 `rg` 因未匹配到旧 Mermaid 连线标签返回退出码 1，聚合命令未回传其余结果 | 改用始终返回结构化计数的 PowerShell 检查，避免把“零匹配”误判为校验失败 |
| 2026-07-13 | 并行读取 ADR 的 JavaScript 数组声明误写为未定义变量赋值，调用在执行前失败 | 修正为普通 `const paths = [...]` 声明后重新执行只读操作 |
| 2026-07-13 | 提交前恢复检查发现 `docs/架构方案.zip` 意外处于缺失状态 | 在提交前从 6 份正式文档重新生成，并再次逐项比对后再暂存 |
