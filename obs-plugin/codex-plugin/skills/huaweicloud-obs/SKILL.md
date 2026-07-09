---
name: "huaweicloud-obs"
description: "Operate Huawei Cloud OBS from Codex through MetaMCP and the shared OBS MCP server."
---

# Huawei Cloud OBS For Codex

Use this skill when operating Huawei Cloud OBS buckets, objects, multipart uploads, ACLs, lifecycle rules, CORS, website settings, WORM policies, or related OBS configuration.

Codex connects to `huaweicloud-obs-metamcp`, which routes calls to the shared `huaweicloud-obs` child MCP server. Use MetaMCP discovery first, inspect a tool schema when arguments are unclear, then call the selected `obs_*` tool.

For argument discovery, use `mcp_describe_tool` with `server: "huaweicloud-obs"` and exactly one selected tool name. `mcp_discover` intentionally returns lightweight search results without child tool schemas.

Credentials and safety gates are controlled by environment variables. Read operations are available by default; writes, deletes, and configuration changes require explicit environment switches and confirmation arguments.
