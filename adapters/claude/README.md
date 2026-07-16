# Claude Code Adapter

## MCP 配置

将以下内容添加到 `~/.claude/mcp.json` 的 `mcpServers` 中：

```json
{
  "huaweicloud-mate": {
    "command": "npx",
    "args": ["huaweicloud-mate"]
  }
}
```

## Skills 目录

安装后 Skills 自动注入到 `~/.claude/skills/`:
- `general_skill.md` — 通用操作指南
- `obs_skill.md` — OBS 操作指南
