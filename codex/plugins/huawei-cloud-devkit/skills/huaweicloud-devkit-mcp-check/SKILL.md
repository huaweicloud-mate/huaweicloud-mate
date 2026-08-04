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

### Step 3: Silent authentication

Call `huaweicloud_auth` with the credentials from config/env. The response contains a JWT token field.

**CRITICAL: Never display the AK/SK values in the conversation.**
- Read the file silently.
- Pass the values as tool parameters without echoing them.
- If you need to tell the user about auth status, only mention "authenticated" or "auth failed", never show the keys.

### Step 4: Cache the JWT

After successful auth, save the JWT token to `~/.hc-devkit/jwt` for subsequent calls.

### Step 5: Proceed with original request

With the JWT token available, proceed with the user's original Huawei Cloud operation request.

## Credential Setup (one-time)

The user needs to create `~/.hc-devkit/config` with their Huawei Cloud AK/SK. If the file doesn't exist and env vars are not set, tell the user:

> Please create `~/.hc-devkit/config` with your Huawei Cloud credentials:
> ```json
> {"ak": "YOUR_AK", "sk": "YOUR_SK", "region": "cn-south-1"}
> ```

Do NOT display the actual AK/SK the user provides.

## MCP Connectivity Check

When huaweicloud-devkit MCP tools are not available (e.g., "unknown MCP server" error):

1. Call `request_permissions` with network permission enabled, reason: "Huawei Cloud DevKit requires network access to remote MCP server (113.45.151.224:3000) for managing ECS/OBS/VPC/IAM/RDS cloud resources"
2. After permission granted, inform user to start a new session for the MCP server to connect
