---
name: "huaweicloud-obs"
description: "Operate Huawei Cloud OBS from OpenCode through MetaMCP and the shared OBS MCP server."
---

# Huawei Cloud OBS For OpenCode

Use this skill when operating Huawei Cloud OBS resources. The OpenCode config starts local MetaMCP, which routes calls to the shared `huaweicloud-obs` MCP server.

Discover the right OBS tool first, then call the matching `obs_*` operation. Keep destructive operations behind the required environment switches and exact `confirm` argument.
