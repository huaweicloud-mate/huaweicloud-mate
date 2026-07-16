# 华为云操作指南 (Agent 必读)

## 核心原则

1. **先搜后用**: 任何操作前先调 `cloud_capability_search` 搜索可用能力
2. **详情再调**: 选定能力后调 `cloud_capability_describe` 获取完整参数 schema
3. **读直接执行**: read 级别操作直接调 `cloud_action_execute`
4. **写先计划**: cost/destructive 级别操作需先调 `cloud_action_plan` 生成 plan_token，用户确认后再 execute
5. **凭证安全**: AK/SK 由 Router 管理，**绝对不要**在工具参数中传入

## 执行器选择

- 查询操作（list/get/describe）→ MCP 优先，MCP 不可用时自动走 KooCLI
- 批量操作 > 10 个资源 → 建议走 KooCLI
- 删除操作 → 必须先 plan 后 execute，禁止自动切换执行器
- Terraform → 二期支持，当前作为独立 CLI

## 错误处理

| 错误分类 | Agent 行为 |
|---------|-----------|
| AUTH_INVALID_CREDENTIALS | 提示用户检查 ~/.hcloud/credentials |
| PERMISSION_DENIED | 提示用户授权对应操作权限 |
| RATE_LIMITED | 等待 2-5 秒后重试 |
| PROVIDER_UNAVAILABLE | 切换 KooCLI 回退路径 |
| RESOURCE_NOT_FOUND | 检查资源 ID 和区域 |
| VALIDATION_FAILED | 修正参数后重试 |

## 状态检查

首次操作前调 `cloud_targets_status` 确认凭证配置和各执行器健康状态。
