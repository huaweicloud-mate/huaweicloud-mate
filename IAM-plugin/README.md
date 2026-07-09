# IAM-plugin

华为云 OpenCode Agent Plugin — 通过 Meta-Tool Gateway 按需发现华为云 API，避免 LLM Context 爆炸。

**10 个 IAM Tool → 3 个 Meta-Tool → LLM 渐进式发现**

## 为什么需要这个插件？

传统 MCP 模式下，所有子 server 的 tool schema 会被全量加载到 LLM context，接入多个华为云服务后轻松突破数万 token/请求。

本插件暴露 **恒定 3 个 meta-tool**（~1200 token），LLM 按需调用：

```
mcp_discover → mcp_describe_tool → mcp_call
     ↓                ↓                ↓
  搜索工具        查看参数 schema    执行调用
```

无论后端挂载多少个华为云服务，LLM 看到的永远是 3 个 tool。

## 前置要求

- **Node.js** >= 20
- **华为云 AK/SK**（在[华为云控制台 > 我的凭证](https://console.huaweicloud.com/iam/) 创建）

## 快速开始

```bash
# 1. 克隆并安装
git clone <repo-url>
cd huaweicloud-mate
npm install

# 2. 配置凭证
cp .env.example .env
# 编辑 .env，填入你的 AK/SK

# 3. 构建
npm run build

# 4. 验证 IAM Server
npm run dev:iam
# 输出: [huawei-iam-server] 已启动，10 个 IAM tool 已注册

# 5. 验证 Gateway
npm run dev
# 输出: [gateway] 已就绪 — 10 个工具已索引，3 个 meta-tool 已暴露
```

## 接入 OpenCode

### Plugin 方式（推荐）

在项目根目录的 `opencode.json` 中添加：

```json
{
  "plugin": ["iam-plugin"]
}
```

本地开发时使用 `"./"` 加载当前目录。

### 手动 MCP 方式

```json
{
  "mcp": {
    "iam-gateway": {
      "type": "local",
      "command": ["node", "./dist/src/index.js"],
      "enabled": true
    }
  }
}
```

## 使用示例

```
你: 帮我查一下华为云有哪些 IAM 用户
你: lisi 在哪些用户组里？
你: 账号下有哪些项目？
你: 查一下 user_id 为 xxx 的用户详情
```

## 可用 IAM 工具

| 工具 | 用途 |
|------|------|
| `list_iam_users` | 查询 IAM 用户列表 |
| `get_iam_user` | 查询指定用户详情 |
| `list_user_groups` | 查询用户组列表 |
| `get_user_group` | 查询指定用户组详情 |
| `list_users_in_group` | 查询用户组中的用户 |
| `list_user_projects` | 查询用户可访问的项目 |
| `list_projects` | 查询项目列表 |
| `get_project` | 查询指定项目详情 |
| `list_roles` | 查询权限列表 |
| `get_role` | 查询指定权限详情 |

> 所有工具均为**只读**操作，不会修改华为云资源。

## 项目结构

```
.
├── index.ts                    # OpenCode Plugin 入口
├── src/
│   ├── index.ts                # Gateway MCP Server（3 个 meta-tool）
│   ├── catalog.ts              # ToolCatalog：内存索引 + 关键词搜索
│   ├── child-manager.ts        # ChildManager：STDIO 子进程管理
│   ├── config.ts               # 配置加载
│   └── signer.ts               # AK/SK 签名（SDK-HMAC-SHA256）
├── servers/
│   └── huawei-iam-server.ts    # 子 MCP Server：10 个 IAM tool
└── skills/
    └── huawei-iam/
        └── SKILL.md            # Agent 技能定义
```

## Context 收益

| | 传统 MCP | Meta-Tool Gateway |
|---|---|---|
| LLM 看到的 tool 数 | 10（随服务增长） | **3（恒定）** |
| tool token/请求 | ~3000+ | **~1200** |
| 接入 5 个服务后 | ~15000 | **仍是 ~1200** |

## 扩展新服务

1. 新建 `servers/huawei-xxx-server.ts`
2. 在 `src/config.ts` 中注册子 server
3. 写 `skills/huawei-xxx/SKILL.md`（可选）

Gateway 无需任何改动。

## License

MIT
