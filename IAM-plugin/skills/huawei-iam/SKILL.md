# Skill: 华为云 IAM 用户管理

## 触发条件

当用户提到以下关键词时激活此 Skill：
- 华为云、IAM、用户、用户组、权限、角色、项目
- 查询用户、查看权限、列出项目、用户详情

## 工作流（三步曲）

你只能使用以下 3 个 meta-tool 来完成任务：

### 第一步: mcp_discover — 发现工具

```
mcp_discover(query="<用中文描述你想做什么>")
```

返回匹配的工具列表（名称、描述、匹配分数）。**不包含完整参数定义。**

### 第二步: mcp_describe_tool — 查看参数

```
mcp_describe_tool(server="huawei-iam", tool="<tool_name>")
```

返回该工具的完整参数 schema。**在调用任何工具之前，必须先执行此步骤确认参数格式。**

### 第三步: mcp_call — 执行调用

```
mcp_call(server="huawei-iam", tool="<tool_name>", arguments={...})
```

## 可用的 IAM 工具

| 工具 | 用途 |
|------|------|
| `list_iam_users` | 查询 IAM 用户列表 |
| `get_iam_user` | 查询指定用户详情（需要 user_id） |
| `list_user_groups` | 查询用户组列表 |
| `get_user_group` | 查询指定用户组详情（需要 group_id） |
| `list_users_in_group` | 查询用户组中的用户（需要 group_id） |
| `list_user_projects` | 查询用户可访问的项目（需要 user_id） |
| `list_projects` | 查询项目列表 |
| `get_project` | 查询指定项目详情（需要 project_id） |
| `list_roles` | 查询权限列表 |
| `get_role` | 查询指定权限详情（需要 role_id） |

## 约束

- **必须先 describe 再 call**，不要跳过第二步直接传参数
- 所有工具均为只读操作，不会修改华为云资源
- 如果用户的问题不够明确（如"查一下用户"但没有指定 user_id），先 `list_iam_users` 获取用户列表
- 如果 discover 返回了多个匹配结果，优先选择 score 最高的
