# huaweicloud-devkit — 仓库标准

---

## 1. 项目元信息

| 字段 | 内容 |
|------|------|
| GitHub | HuaweiCloud/huaweicloud-devkit ： https://github.com/huaweicloud/huaweicloud-devkit |
| GitCode (国内) | huaweicloud/huaweicloud-devkit：https://gitcode.com/huaweicloud/huaweicloud-devkit|
| Maintainer | [yuanbeyond (sunsiyuan)](https://github.com/yuanbeyond) |
| Triage | [zrr000212-netizen (zhangranran)](https://github.com/zrr000212-netizen) |
| 许可证 | Apache License 2.0 |
| 行为准则 | [Contributor Covenant](https://www.contributor-covenant.org/) |

---

## 2. huaweicloud-devkit 目录结构

> ⚠️ 暂定 (Draft)，后续根据开发进度调整。

```
huaweicloud-devkit/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                     # PR: lint → test → build
│   │   ├── cd-staging.yml             # merge main → 预发
│   │   ├── cd-production.yml          # release tag → 生产
│   │   └── security-scan.yml          # CodeQL + npm audit
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── ISSUE_TEMPLATE/
│
├── scripts/                           # 本地 MCP 插件
│   ├── server.js
│   ├── crypto.js
│   ├── huawei-client.js
│   └── setup.js
│
├── cloud-server/                      # 云端 A2A 服务
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/
│   │   ├── middleware/
│   │   │   ├── auth.js
│   │   │   └── rate-limiter.js
│   │   ├── services/
│   │   │   ├── task-manager.js
│   │   │   ├── sandbox.js
│   │   │   └── audit.js
│   │   ├── agents/
│   │   │   ├── orchestrator.js
│   │   │   ├── router.js
│   │   │   └── executors/
│   │   ├── catalog/
│   │   └── policy/
│   ├── config/
│   ├── docker/
│   │   ├── Dockerfile.server
│   │   ├── Dockerfile.sandbox
│   │   └── docker-compose.yml
│   ├── deploy.sh
│   └── package.json
│
├── skills/                            # Skill 策略定义
├── .codex-plugin/                     # Codex 插件清单
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── CHANGELOG.md
│   └── DEPLOY.md
│
├── .gitignore
├── .env.example
├── package.json
├── LICENSE                            # Apache 2.0 (必选)
├── README.md                          # 项目介绍、功能、快速开始 (必选)
├── CONTRIBUTING.md                    # 贡献流程 (必选)
├── CODE_OF_CONDUCT.md                 # 行为准则 (必选)
├── SECURITY.md                        # 安全漏洞报告流程 (可选)
├── OWNERS                             # 维护者名单 + GitHub 账号
└── REPO_STANDARD.md                   # 本文件
```

---

## 3. 必选文件

| 文件 | 要求 | 内容要点 |
|------|:---:|------|
| `README.md` | 必选 | 项目名称及描述、功能概要、快速开始、许可证、联系方式 |
| `CONTRIBUTING.md` | 必选 | Issue 规范、提交指南、开发环境搭建 |
| `CODE_OF_CONDUCT.md` | 必选 | 引用 Contributor Covenant |
| `LICENSE` | 必选 | Apache License 2.0 全文 |
| `SECURITY.md` | 可选 | 安全漏洞报告流程 |
| `CHANGELOG.md` | 强建议 | feat/fix 类 PR 必须更新 |

---

## 4. 分支策略

```
main                     # 生产就绪，受保护，仅通过 PR 合并
  ├── develop            # 集成分支
  ├── release/vX.Y.Z     # 发布准备
  └── hotfix/vX.Y.Z      # 紧急修复
```

---

## 5. 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，格式：`<type>(<scope>): <subject>`。

| Type | 说明 | Scope | 对应模块 |
|------|------|-------|----------|
| `feat` | 新功能 | `mcp` | `scripts/` |
| `fix` | Bug 修复 | `server` | 路由层 |
| `refactor` | 重构 | `auth` | 认证模块 |
| `perf` | 性能优化 | `sandbox` | 容器管理 |
| `docs` | 文档 | `task` | 任务管理 |
| `test` | 测试 | `executor` | 执行通道 |
| `chore` | 构建/依赖 | `ci` | CI/CD |
| `security` | 安全修复 | `docs` | 文档 |

示例：
```
feat(executor): add KooCLI executor with JSON output parsing
Closes #42

security(auth): enforce anti-replay with 5-minute timestamp tolerance
Refs: SEC-2026-003
```

---

## 6. 版本管理

遵循 [SemVer 2.0](https://semver.org/lang/zh-CN/)，格式 `v<MAJOR>.<MINOR>.<PATCH>`。

**发布流程**：`develop → release/vX.Y.Z → PR → main (需 2 Approve) → git tag → CI 自动部署 

---

## 7. Issue 管理

| 标签 | 处理 SLA |
|------|:---:|
| `bug` | 3 个工作日 |
| `feature` | 5 个工作日回应 |
| `security` | 1 个工作日 |
| `good first issue` | — |

长期未处理 Issue，HuaweiClouddev 管理员有权向责任部门通报。维护者团队每周清理一次。

---

## 8. Code Review 规范

### PR 检查清单

- [ ] 标题遵循 Conventional Commits，关联 Issue
- [ ] CI 通过 (格式校验lint + 测试用例校验test + 构建成功build)
- [ ] Action: 无硬编码凭证、无 AK/SK/Token 泄露、输入校验 
- [ ] 至少 2 Approve : 
  - [] 可维护性 | |函数 < 50 行、职责单一、命名清晰 |
  - [ ] 性能 | 容器调用次数、内存占用、队列不堆积 |
- [ ] `docs/CHANGELOG.md` 已更新 (新特性feat/修复fix 类)
- [ ] 安全相关变更需安全负责人额外 Approve
   - [ ]  | 正确性 | 边界条件、错误处理、并发安全 |


---

## 9. CI/CD 流水线

| 阶段 | 触发 | 步骤 |
|------|------|------|
| PR | PR → develop/main | checkout → npm ci → lint → test → audit → build docker |
| 预发 | merge → main | CI → 构建镜像 → 推送 SWR → 部署预发 ECS → 冒烟测试 |
| 生产 | git tag vX.Y.Z | CI → 构建镜像 → 人工审批 → 灰度 10% → 监控 5min → 全量 |

---

## 10. 许可证

默认 Apache License 2.0。所有源文件需包含版权声明头：

```javascript
// Copyright [yyyy] HuaweiCloud
// Licensed under the Apache License, Version 2.0
```

依赖合规：所有依赖 (express、dockerode 等) 均为 MIT/Apache 2.0，无 GPL 污染。

---

## 11. 维护与归档

### 项目管理员
- Huaweiclouddev 账号 负责管理 OWNERS 文件及维护者团队
- 当前: Maintainer [yuanbeyond](https://github.com/yuanbeyond) / Triage [zrr000212-netizen](https://github.com/zrr000212-netizen)

### 项目归档
长期未维护项目：通知后 **30 天**内提交整改计划，逾期由 HuaweiCloud 管理员归档。归档后仍可访问，但不再接受新 Issue/PR。

---

## 12. 冲突解决

1. 项目内部冲突由维护者团队优先协商
2. 无法解决时提交至华为云开发者 TMG 仲裁

---

## 13. 联系方式

- 邮箱: `HuaweiCloudDeveloper@huawei.com`
- GitHub: [HuaweiCloud](https://github.com/HuaweiCloud)
- GitCode: [huaweicloud](https://gitcode.com/huaweicloud)
- 论坛: [华为云开发者社区](https://developer.huaweicloud.com)
