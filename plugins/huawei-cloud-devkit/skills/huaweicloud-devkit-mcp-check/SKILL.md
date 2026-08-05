---
name: huaweicloud-devkit-mcp-check
description: Auto-authenticates with huaweicloud-devkit MCP server by reading local credentials. Automatically detects when the huaweicloud-devkit MCP server is not connected and guides network authorization to fix it. Use when working with Huawei Cloud DevKit plugin, huawei-cloud-devkit, or HC DevKit tasks involving ECS, OBS, VPC, IAM, or RDS cloud resource management.
---

# Huawei Cloud DevKit Auto-Auth

## Auto-Authentication (DO NOT display credentials in conversation)

Before calling any `huaweicloud_*` tool (except `huaweicloud_auth` itself), follow this silent authentication flow:

### Step 1: Check for cached JWT

Check if `~/.hc-devkit/jwt` file exists and contains a non-empty token.

If a valid cached JWT exists, inject it as the `token` parameter when calling `huaweicloud_invoke`, `huaweicloud_voucher_status`, `huaweicloud_voucher_claim`, or `huaweicloud_set_credentials`.

### Step 2: Read local config for credentials

If no cached JWT exists, read `~/.hc-devkit/config`:

```json
{
  "ak": "<YOUR_AK>",
  "sk": "<YOUR_SK>",
  "region": "cn-south-1"
}
```

Also check environment variables as fallback: `HUAWEICLOUD_AK`, `HUAWEICLOUD_SK`, `HUAWEICLOUD_REGION`.

### Step 3: Silent authentication (DO NOT expose credentials in UI)

Read `~/.hc-devkit/config` to get the project path, then run the auth command with this exact format (replace PATH with actual project path):

```bash
node D:/project/huaweicloud-mate/bin/hc-devkit.js --auth-only
```

**CRITICAL**: If `~/.hc-devkit/config` exists, use this bash command instead of calling `huaweicloud_auth` MCP tool. The bash command reads config locally and completes auth without exposing AK/SK in the MCP tool call UI.

### Step 4: Cache the JWT

After successful auth, save the JWT token to `~/.hc-devkit/jwt` for subsequent calls.

### Step 5: Proceed with original request

With the JWT token available, proceed with the user's original Huawei Cloud operation request.

## Credential Setup (one-time)

If `~/.hc-devkit/config` doesn't exist and env vars are not set, **automatically create the config file for the user** with a template. Do NOT just tell them — actually create it.

Steps:
1. Check if `~/.hc-devkit/config` exists
2. If it does NOT exist, use the `write` tool to create it with this content:

```json
{
  "ak": "YOUR_ACCESS_KEY",
  "sk": "YOUR_SECRET_KEY",
  "region": "cn-south-1"
}
```

3. After creating, tell the user:

> 已在 `~/.hc-devkit/config` 创建凭证配置文件，请填写你的 AK 和 SK 后即可使用。

Do NOT ask the user for AK/SK directly. Do NOT display the actual AK/SK values if the user provides them.

## MCP Connectivity Check

When huaweicloud-devkit MCP tools are not available (e.g., "unknown MCP server" error):

1. Call `request_permissions` with network permission enabled, reason: "Huawei Cloud DevKit requires network access to remote MCP server (113.45.151.224:3000) for managing ECS/OBS/VPC/IAM/RDS cloud resources"
2. After permission granted, inform user to start a new session for the MCP server to connect
