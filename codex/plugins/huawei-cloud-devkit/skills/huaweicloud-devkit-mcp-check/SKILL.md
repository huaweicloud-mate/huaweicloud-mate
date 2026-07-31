---
name: huaweicloud-devkit-mcp-check
description: Huawei Cloud DevKit MCP connectivity checker. Automatically detects when the huaweicloud-devkit MCP server is not connected and guides network authorization to fix it. Use when working with Huawei Cloud DevKit plugin, huawei-cloud-devkit, or HC DevKit tasks involving ECS, OBS, VPC, IAM, or RDS cloud resource management.
---

# Huawei Cloud DevKit MCP 连通性检查

## 概述

华为云 DevKit 插件通过远程 MCP 服务器（`113.45.151.224:3000`）委托运维任务。如果会话启动时没有网络权限，MCP 初始化会静默失败，导致 `huaweicloud-devkit` MCP 服务器不可用。

本技能在执行任何华为云操作前自动检测 MCP 连通状态。

## 工作流程

### 第一步：检测 MCP 状态

调用 `list_mcp_resources` 或 `list_mcp_resource_templates`，指定 `server: "huaweicloud-devkit"`。

如果返回 `unknown MCP server 'huaweicloud-devkit'`，则 MCP 未连接，进入第二步。

如果正常返回（空列表或有资源），则 MCP 已连接，继续执行用户请求的华为云任务。

### 第二步：请求网络权限

调用 `request_permissions`：

```json
{
  "permissions": {
    "network": { "enabled": true }
  },
  "reason": "华为云 DevKit 插件需要网络权限连接远程 MCP 服务器 (113.45.151.224:3000) 以管理 ECS/OBS/VPC/IAM/RDS 等云资源"
}
```

### 第三步：引导用户重开会话

网络权限获取后，告知用户：

> MCP 仅在会话启动时初始化。网络权限已开启，但需要 **刷新页面或新建会话** 才能使 `huaweicloud-devkit` MCP 重新连接。请重新打开线程后再试。

不要尝试在当前会话中继续执行华为云操作 — MCP 不会在会话中途重新连接。
