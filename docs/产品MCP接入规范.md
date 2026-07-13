# 华为云产品 MCP 接入规范

状态：Proposed v0.3-lite
适用：随插件内置发布的华为云官方公网 Streamable HTTP MCP

## 1. 首版边界

首版只接入 npm 包内置的官方产品 MCP：

- 不支持第三方、社区或用户自定义 Provider；
- 不支持运行时注册 endpoint；
- 不建设动态 Provider Registry、签名、吊销或远程 denylist；
- 新增、修改或删除 Provider 必须发布新的插件版本。

## 2. 职责

产品 MCP 团队负责：

- 产品工具实现、输入 schema、业务校验和错误解释；
- 公网 Streamable HTTP 数据面；
- 同源 HTTPS credential session endpoint；
- capability 风险和作用域元数据；
- AK/SK 内存会话的安全实现；
- 版本、健康、容量和故障响应。

插件仓库负责：

- 内置 Provider descriptor；
- capability 与 KooCLI 映射；
- Router 三工具协议；
- Provider Client、KooCLI Adapter、风险确认和脱敏；
- 通过代码评审和 npm 发版更新内置 Provider。

## 3. 内置 Provider descriptor

```yaml
schemaVersion: huaweicloud-agent-provider/v1-lite
providerId: huaweicloud-ecs
product: ecs
expectedProviderVersionRange: ^1.0.0
dataPlane:
  transport: streamable-http
  endpoint: https://ecs-mcp.example.huaweicloud.com/mcp
credentialSession:
  endpoint: https://ecs-mcp.example.huaweicloud.com/credential-sessions
  protocol: huaweicloud-credential-session/v1
  maxTtlSeconds: 900
  routing: opaque-route-token
capabilities:
  path: capabilities/ecs.json
  digest: sha256:...
health:
  endpoint: https://ecs-mcp.example.huaweicloud.com/health
compatibility:
  providerContractVersion: huaweicloud-agent-provider-contract/v1-lite
  credentialSessionProtocol: huaweicloud-credential-session/v1
  toolSchemaDigest: sha256:...
```

约束：

- data plane、credential session 和 health endpoint 必须同源；
- endpoint 只能来自 npm 内置 descriptor；
- 工具参数、Skill、Agent 和 workspace 不能覆盖 endpoint；
- Provider 版本变化必须通过插件发版更新兼容信息；
- health/initialize 必须返回实际 Provider contract、版本、capability digest 和 tool schema digest；
- 任一值与 descriptor 不兼容时 Router fail closed。

## 4. Capability metadata

每个能力至少提供：

```json
{
  "schemaVersion": "huaweicloud-agent-capability/v1-lite",
  "capabilityId": "huaweicloud.ecs.server.create.v1",
  "product": "ecs",
  "summary": "Create an ECS server",
  "inputSchema": {},
  "outputSchema": {},
  "scope": {
    "region": "required",
    "project": "required"
  },
  "operationKind": "write",
  "riskTags": ["cost", "privileged"],
  "confirmationRequired": true,
  "executors": {
    "providerMcp": {
      "providerId": "huaweicloud-ecs",
      "tool": "ecs_create_server",
      "inputSchemaDigest": "sha256:..."
    }
  },
  "defaultExecutor": "provider-mcp",
  "outputPolicy": {
    "sensitivePaths": ["/adminPass"],
    "maxBytes": 262144,
    "allowProviderText": false
  }
}
```

`operationKind` 必须是 `read` 或 `write`；`riskTags` 可组合 `destructive`、`privileged`、`cost`、`sensitive-read`。所有 write、任一风险标签以及未知或不完整元数据均必须确认或 fail closed。

`inputSchema` 和 `outputSchema` 必须使用包内允许的 JSON Schema Draft 2020-12 子集：禁止远程 `$ref`、动态引用和自定义可执行关键字，并限制引用深度、总节点数与正则复杂度。构建期不能完整解析或运行时校验不通过时 fail closed。

## 5. 数据面要求

- 使用 MCP Streamable HTTP；
- `tools/list` 和健康检查不需要用户凭证；
- 云资源操作必须绑定有效 credential session；
- session ID 和 route token 通过受保护的 HTTP 元数据/Header 传递，不进入 Tool schema；
- v1 固定使用 `Hwc-Credential-Session` 和 `Hwc-Session-Route` 两个 Header，网关和 Provider 必须在 access log、trace 和错误中清理其值；
- Tool 输入不得包含 AK、SK、任意 endpoint、可执行路径或 credentials 文件路径；
- 支持 correlation ID、取消、超时和结构化错误；
- 返回华为云 request ID 和实际 region/project；
- health/initialize 返回实际契约版本与 schema digest，供 Router fail-closed 校验；
- 副作用操作不得在超时后由 Provider 自动重放。

## 6. Credential session

### 6.1 建立

```http
POST /credential-sessions
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "protocol": "huaweicloud-credential-session/v1",
  "accessKey": "...",
  "secretKey": "...",
  "credentialGeneration": "uuid",
  "requestedTtlSeconds": 900
}
```

响应：

```json
{
  "protocol": "huaweicloud-credential-session/v1",
  "sessionId": "opaque-high-entropy-id",
  "routeToken": "opaque-high-entropy-route-token",
  "providerInstanceId": "provider-instance-id",
  "credentialGeneration": "uuid",
  "expiresAt": "...",
  "accountIdentity": {
    "accountId": "...",
    "domainId": "..."
  }
}
```

要求：

- 仅接受 HTTPS；
- 不接受跨域重定向；
- AK/SK 不进入任何日志、trace、metric、数据库、磁盘 cache 或 crash dump；
- Provider 必须验证账号身份；
- Core 必须把返回账号与 `auth set` 已验证并绑定到当前 credentials generation 的 identity 比对；
- TTL 最大 900 秒；
- session 只存于当前 Provider 实例内存；
- 同源网关必须依据 route token 把数据面和撤销请求路由到该实例。

### 6.2 使用与清理

- session ID 和 route token 不得跨 Provider 或 Provider instance 复用；
- Provider 重启后所有 session 失效；
- 过期、显式撤销或账号不匹配时立即清理；
- Core 发现凭证 generation 变化后停止复用旧 session 并尽力撤销；
- 数据面只通过 `Hwc-Credential-Session` 和 `Hwc-Session-Route` 传递 session ID 与 route token，不重复传输 AK/SK；
- session ID 和 route token 不得出现在 Tool 返回值或普通日志中。

### 6.3 撤销

```http
DELETE /credential-sessions/{sessionId}
Hwc-Session-Route: {routeToken}
```

Core 对当前进程已知 session 尽力撤销。其他 Core 在执行前通过 credentials generation 变化停止复用旧 session。Provider 即使未收到撤销，也必须保证 session 在不超过 900 秒的 TTL 或实例重启后失效；首版不承诺全局立即撤销。

## 7. 响应契约

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

Core 必须把 effective account 与当前 credentials generation 已验证 identity 比较。region/project 与请求不一致时返回作用域错误，不静默接受。

## 8. 错误模型

Provider 必须映射为稳定分类：

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
OUTCOME_UNKNOWN
UNKNOWN
```

错误不得回显 AK/SK、session ID、Authorization、签名、完整敏感响应或内部堆栈。

## 9. 发布流程

```text
产品团队提供 endpoint 与 capability 元数据
  -> 仓库代码评审
  -> 契约和安全测试
  -> 更新内置 descriptor
  -> 发布新的 npm 版本
```

首版不提供 Provider 自助注册平台。产品 MCP 未准备好时，对应能力由 KooCLI 映射覆盖。

## 10. 最小接入测试

1. Provider descriptor 和同源 endpoint 校验；
2. Streamable HTTP、`tools/list`、取消和超时；
3. AK/SK 不出现在日志、trace、错误和磁盘；
4. session 过期、route token 路由、撤销、重启、generation 变化和账号不匹配；
5. Provider contract、版本、capability/tool schema digest 失配时 fail closed；
6. read/write 与 destructive/privileged/cost/sensitive-read 复合风险元数据；
7. input/output schema 限制、敏感路径脱敏和输出上限；
8. request ID 与实际作用域；
9. 超时后不自动重放副作用操作；
10. 与 Router search、describe、execute 的端到端测试。
