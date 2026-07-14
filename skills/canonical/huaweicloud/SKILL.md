---
name: huaweicloud
description: Manage supported Huawei Cloud resources through the guarded huaweicloud-agent MCP Router. Use for capability discovery, schema inspection, reads, previews, and approved cloud changes.
---

# Huawei Cloud operations

Use only the three tools exposed by the `huaweicloud-agent` MCP server:

1. Call `cloud_capabilities_search` to find a supported capability.
2. Call `cloud_capability_describe` before execution to obtain the exact argument schema, scope, risk tags, and executor metadata.
3. Call `cloud_action_execute` with only arguments allowed by that capability.

For a write or other risky capability, the first execute call returns a preview. Present its material effects to the user. If the user chooses to continue, repeat the original capability, arguments, scope, and executor preference with the returned `previewId`. The Router opens its own approval UI and handles the signed approval receipt internally.

Never ask the user to type a password for approval. Never request or place AK/SK values in prompts, tool arguments, files, or logs. Do not call arbitrary shell commands, invent endpoints, bypass a preview, change risk tags, or substitute a different executable. If a capability is absent, explain that it is not yet supported instead of improvising a direct cloud call.

The current development catalog is local-only and does not access Huawei Cloud or credentials. Do not describe a development result as a real cloud operation.
