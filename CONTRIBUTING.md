# Contributing to Huaweicloud DevKit

Thank you for your interest in contributing!

## Issue 规范

- 提交 Bug 请使用 `bug` 标签，附上复现步骤和环境信息
- 提交 Feature 请使用 `feature` 标签，说明使用场景和期望行为
- 安全问题请勿公开提交 Issue，请发送至 SECURITY.md 中列出的联系方式

## 开发环境搭建

```bash
# 克隆仓库
git clone git@github.com:huaweicloud-mate/huaweicloud-mate.git
cd huaweicloud-mate

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 运行测试
npm test
```

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，格式：`<type>(<scope>): <subject>`

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/依赖 |
| `security` | 安全修复 |

示例：
```
feat(sandbox): add KooCLI executor with JSON output parsing
fix(auth): enforce anti-replay with 5-minute timestamp tolerance
```

## Code Review

- PR 标题遵循 Conventional Commits
- CI 必须通过 (lint + test + build)
- 至少 2 人 Approve
- 无硬编码凭证、无 AK/SK/Token 泄露
- `docs/CHANGELOG.md` 已更新 (feat/fix 类 PR)

## 许可证

Apache License 2.0。所有贡献默认以此许可证发布。
