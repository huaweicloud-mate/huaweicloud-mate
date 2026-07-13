# 华为云产品 MCP 接入规范

状态：Proposed v1  
适用：由华为云产品部托管的公网 Streamable HTTP MCP

## 1. 职责划分

产品部负责：

- 产品 MCP 的工具实现、schema、业务校验和错误解释；
- 公网 Streamable HTTP 数据面；
- 独立凭证会话控制面；
- 风险、作用域、幂等和审计元数据；
- 版本兼容、健康、容量与故障响应。

插件平台团队负责：

- Provider Manifest schema；
- 审核、签名、发布和吊销；
- Registry 公钥和客户端信任根；
- Provider conformance suite；
- 紧急禁用和兼容性治理。

Agent 与普通用户不能注册或覆盖 Provider endpoint。

## 2. Provider Manifest

```yaml
schemaVersion: huaweicloud-agent-provider/v1
providerId: huaweicloud-obs
product: obs
version: 1.0.0
owner:
  teamId: obs-product-team
  supportContact: obs-oncall
dataPlane:
  transport: streamable-http
  endpoint: https://mcp.obs.example.com/mcp
  mcpProtocolRange: "..."
  channelAuthProfile: hcp-mtls-v1
credentialControl:
  endpoint: https://mcp.obs.example.com/credential-sessions
  protocol: hcp-credential-session/v1
  channelAuthProfile: hcp-mtls-v1
  envelopeEncryption:
    algorithm: RSA-OAEP-256+A256GCM
    keyId: obs-cred-2026-01
    publicKeyJwk: {}
  maxTtlSeconds: 900
  persistence: memory-only
identityProof:
  protocol: hcp-account-proof/v1
capabilities:
  indexUrl: https://mcp.obs.example.com/capabilities.json
  sha256: "..."
regions: ["*"]
riskMetadata: required
audit:
  protocol: hcp-request-id/v1
health:
  endpoint: https://mcp.obs.example.com/health
registry:
  issuedAt: "..."
  expiresAt: "..."
  keyId: registry-signing-key-1
  signature: "..."
```

Manifest 中的 endpoint、公钥、协议和 owner 均属于受信配置。Core 不接受调用参数覆盖。

## 3. 数据面要求

- 使用 MCP Streamable HTTP；
- `tools/list` 或 capability index 在不建立用户凭证会话时可读取；
- 资源操作必须绑定有效 credential session；
- session binding 通过受保护连接元数据/Header 传递，不进入工具 schema；
- 工具输入不得包含 AK、SK、SecurityToken、任意 endpoint 或凭证引用；
- 支持请求取消、超时和唯一 correlation ID；
- 副作用工具必须声明风险、幂等语义和实际作用域。

## 4. Capability metadata

每个工具至少提供：

```json
{
  "capabilityId": "huaweicloud.obs.bucket.create.v1",
  "tool": "obs_create_bucket",
  "summary": "Create an OBS bucket",
  "inputSchema": {},
  "scope": {
    "account": "required",
    "project": "not-applicable",
    "region": "required"
  },
  "risk": {
    "level": "write",
    "costImpact": true,
    "publicExposure": false,
    "sensitiveOutput": false
  },
  "idempotency": {
    "class": "conditionally-idempotent",
    "keySupported": true
  },
  "requiredPermissions": ["obs:bucket:CreateBucket"]
}
```

风险级别必须是 `read`、`write`、`destructive`、`privileged` 或 `cost`，可以同时增加细分 flags。

## 5. 凭证会话控制面

### 5.1 建立会话

```http
POST /credential-sessions
Content-Type: application/json
```

请求在 mTLS 通道上发送，敏感 payload 还必须使用 Manifest 公钥做信封加密：

```json
{
  "protocol": "hcp-credential-session/v1",
  "providerId": "huaweicloud-obs",
  "deviceId": "opaque-device-id",
  "expectedAccountId": "...",
  "requestedTtlSeconds": 900,
  "envelope": {
    "keyId": "obs-cred-2026-01",
    "encryptedKey": "base64",
    "iv": "base64",
    "ciphertext": "base64",
    "tag": "base64"
  }
}
```

解密后的内容只包含 AK/SK 和协议所需 nonce/timestamp，不包含 Agent prompt 或工具参数。

响应：

```json
{
  "sessionId": "opaque-random-id",
  "expiresAt": "...",
  "providerInstanceId": "...",
  "accountIdentity": {
    "accountId": "...",
    "domainId": "..."
  }
}
```

Core 必须比对 `expectedAccountId`。不匹配时立即撤销并禁止数据面动作。

### 5.2 会话使用

- session 绑定 provider、device、account、provider instance 和 MCP connection；
- 不允许跨用户、跨 provider 或跨 device 复用；
- TTL 最大 900 秒；
- Provider 重启后所有 session 失效；
- 内存中的凭证不得被序列化、交换、转储或传给未登记的下游服务。

### 5.3 撤销

```http
DELETE /credential-sessions/{sessionId}
```

断连、超时、凭证轮换、target 删除、账号不匹配、Provider 吊销时 Core 必须调用撤销；Provider 即使未收到撤销，也必须依靠 TTL 和连接生命周期清理。

## 6. 响应契约

资源操作至少返回：

```json
{
  "result": {},
  "execution": {
    "providerRequestId": "...",
    "correlationId": "...",
    "effectiveAccountId": "...",
    "effectiveProjectId": "...",
    "effectiveRegion": "...",
    "providerVersion": "1.0.0"
  }
}
```

Core 校验 effective account；project/region 与计划不一致时不得静默接受。

## 7. 错误模型

Provider 必须映射到稳定分类：

```text
AUTH_SESSION_REQUIRED
AUTH_SESSION_EXPIRED
ACCOUNT_MISMATCH
PERMISSION_DENIED
INVALID_SCOPE
VALIDATION_FAILED
CONFLICT
RATE_LIMITED
PROVIDER_UNAVAILABLE
UPSTREAM_TIMEOUT
UNKNOWN
```

错误中不得回显请求签名、Authorization、AK/SK、完整安全 token 或内部堆栈。

## 8. Registry 生命周期

```text
product submit -> schema validation -> conformance -> security review
               -> platform signing -> publish -> observe
               -> renew / suspend / revoke
```

- 产品部提交 unsigned manifest；
- 插件平台团队审核后签名；
- Core 周期拉取并保留 last-known-good；
- 吊销列表优先于缓存有效期；
- 被吊销 Provider 立即停止新会话和资源动作；
- 过期 manifest 可以保留诊断信息，但不能建立新的凭证会话。

## 9. Conformance 门槛

每个 Provider 必须通过：

1. Manifest schema、签名和 capability digest 测试；
2. Streamable HTTP 协议兼容测试；
3. mTLS 双向身份和错误证书拒绝测试；
4. envelope key 轮换、错误 key ID 和重放拒绝测试；
5. 凭证日志/trace/数据库/cache/core dump 扫描；
6. session 过期、撤销、断连、重启和账号不匹配测试；
7. read/write/destructive/privileged/cost 风险元数据测试；
8. request ID 与 effective scope 测试；
9. 超时、取消、限流和容量测试；
10. 不重复执行副作用动作的幂等测试。

未通过安全评审的 Provider 只能进入 discovery-only 状态；该产品仍可由 KooCLI 提供执行能力。
