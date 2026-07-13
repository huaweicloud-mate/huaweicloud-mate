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
version: 1.0.0
dataPlane:
  transport: streamable-http
  endpoint: https://ecs-mcp.example.huaweicloud.com/mcp
credentialSession:
  endpoint: https://ecs-mcp.example.huaweicloud.com/credential-sessions
  protocol: huaweicloud-credential-session/v1
  maxTtlSeconds: 900
capabilities: capabilities/ecs.json
health:
  endpoint: https://ecs-mcp.example.huaweicloud.com/health
```

约束：

- data plane、credential session 和 health endpoint 必须同源；
- endpoint 只能来自 npm 内置 descriptor；
- 工具参数、Skill、Agent 和 workspace 不能覆盖 endpoint；
- Provider 版本变化必须通过插件发版更新兼容信息。

## 4. Capability metadata

每个能力至少提供：

```json
{
  "capabilityId": "huaweicloud.ecs.server.create.v1",
  "tool": "ecs_create_server",
  "summary": "Create an ECS server",
  "inputSchema": {},
  "scope": {
    "region": "required",
    "project": "required"
  },
  "risk": "cost",
  "sensitiveOutput": false,
  "requestIdField": "request_id"
}
```

`risk` 必须是 `read`、`write`、`destructive`、`privileged` 或 `cost`。Router 使用该字段决定是否执行两阶段确认。

## 5. 数据面要求

- 使用 MCP Streamable HTTP；
- `tools/list` 和健康检查不需要用户凭证；
- 云资源操作必须绑定有效 credential session；
- session ID 通过受保护的 HTTP 元数据/Header 传递，不进入 Tool schema；
- Tool 输入不得包含 AK、SK、任意 endpoint、可执行路径或 credentials 文件路径；
- 支持 correlation ID、取消、超时和结构化错误；
- 返回华为云 request ID 和实际 region/project；
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
  "requestedTtlSeconds": 900
}
```

响应：

```json
{
  "sessionId": "opaque-high-entropy-id",
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
- Core 必须比对返回的账号身份；
- TTL 最大 900 秒；
- session 只存于当前 Provider 实例内存。

### 6.2 使用与清理

- session ID 不得跨 Provider 或 Provider instance 复用；
- Provider 重启后所有 session 失效；
- 过期、显式撤销、凭证更新或账号不匹配时立即清理；
- 数据面只使用 session ID，不重复传输 AK/SK；
- session ID 不得出现在 Tool 返回值或普通日志中。

### 6.3 撤销

```http
DELETE /credential-sessions/{sessionId}
```

Core 在 `auth set`、`auth remove`、卸载或显式退出时尽力撤销。Provider 即使未收到撤销，也必须依赖 TTL 和进程生命周期清理。

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

Core 必须校验 effective account。region/project 与请求不一致时返回作用域错误，不静默接受。

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
4. session 过期、撤销、重启和账号不匹配；
5. read/write/destructive/privileged/cost 元数据；
6. request ID 与实际作用域；
7. 超时后不自动重放副作用操作；
8. 与 Router search、describe、execute 的端到端测试。
