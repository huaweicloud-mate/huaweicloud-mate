# 华为云 Agent 插件技术架构共创计划

## 目标
与用户共同完成一个可落地、可扩展的华为云 Agent 插件技术架构，使插件统一集成 MCP、Skills 与 KooCLI，首版支持 OpenCode、Claude Code、Codex、华为云码道，并能够低成本扩展到其他 Agent。

## 当前状态
- 当前阶段：阶段 5（架构评审）
- 理解度目标：达到并经用户确认至少 90%
- 当前理解度：约 95%
- 仓库状态：空 Git 仓库，尚无实现约束

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

### 阶段 5：评审与定稿（进行中）
- [x] 用关键场景和故障场景验证架构
- [ ] 用户完成 Proposed v0.2 文档终审
- [x] 输出总体架构文档和可执行的首版实施计划

## 当前架构假设（待验证）
1. `mate-core` 是 Agent 无关的本地控制平面，Agent adapter 只负责安装布局和能力映射。
2. Agent 默认只看见少量 meta-tools，由 core 根据 catalog 按需路由到产品 MCP，避免全量 tools 注入上下文。
3. 产品部独立交付 MCP server 与元数据；本项目负责接入契约、发现、编排、治理和分发，不复制产品 OpenAPI 实现。
4. KooCLI 既是补充 MCP 覆盖面的执行后端，也可能被 Skills 直接编排，但其权限和审计需统一纳入 core 治理。
5. 同一发行物通过 adapter 安装到多个 Agent，而非为每个 Agent 维护独立业务实现。

## 已确认决策（2026-07-13 第一轮）
1. 采用类似 npm 命令的一键安装体验。
2. 首版支持 OpenCode、Claude Code、Codex、华为云码道的本地 CLI/桌面开发环境。
3. `D:\CodeSpace\AI-Plugin` 仅作为 MCP 预研 Demo 参考，不作为可落地基线。
4. 不直接依赖 MetaMCP；只参考 namespace、catalog、middleware，自研轻量 Tool Router MCP。
5. 产品 MCP 由华为云托管为 Streamable HTTP 服务，通过中心注册表统一发布。
6. KooCLI 与产品 MCP 同等作为云资源操作路径，由 Agent 根据场景选择。
7. 首版采用 AK/SK；查询默认允许，写/删等按统一策略确认并审计。
8. OS/CPU 支持矩阵跟随 KooCLI；首版覆盖 OBS、ECS、VPC、IAM。

## 已确认决策（2026-07-13 第二轮）
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
