# ADR-0027：本地最小 OBS Provider 与短会话替身

状态：Accepted
日期：2026-07-14

后续状态：ADR-0048 将该实现确认为首版内置 OBS provider；它仍不冒充 Streamable HTTP 产品 MCP，后续替换接口保持不变。

## 背景

真实产品 MCP 尚不能提供，但首版需要先验证安全凭证、账号身份和 Router 的真实只读云调用。用户已确认可以先由插件封装最小 MCP，待正式产品 MCP 到位后替换。

## 决定

- 内置一个实现 `huaweicloud.obs.bucket.list.v1`、`huaweicloud.obs.bucket.create.v1` 的本地 OBS provider；后续 ADR-0031 在相同边界内补充 `huaweicloud.obs.bucket.delete.v1` 空桶删除；
- 使用 OBS 官方 `ListBuckets` header 签名协议，endpoint 只能由内置规则生成；
- `auth set` 以同一固定只读能力验证 AK/SK，并把响应 Owner ID 绑定为 account/domain identity；
- AK/SK 只从权限受限凭证文件进入本地 provider，不进入 Tool 参数、日志或结果；
- provider 在进程内创建随机 session ID、route token 和 provider instance 绑定，TTL 不超过 900 秒；
- 每次执行复核 credentials generation、已验证账号和 OBS 实际 Owner ID；
- 创建私有桶标记为 `write + privileged + cost`，删除空桶标记为 `write + destructive + privileged`；Router 在 dispatch 前强制受信点击审批，写请求不重试，连接中断归类为 `OUTCOME_UNKNOWN`；
- XML 响应限制为 1 MiB、严格 UTF-8，并拒绝 DTD、实体声明、CDATA、未知字段和超限列表；
- 不引入当前存在已知 XML 构建器安全告警的 OBS SDK 依赖链；
- 保留不访问凭证和网络的 reference provider 作为协议测试 fixture。

## 结果

该替身可以完成真实只读 OBS 调用和 Router 端到端开发，但它不是官方 Streamable HTTP 产品 MCP，不满足正式 Provider descriptor、同源 credential endpoint、health/initialize 和产品 owner 的发布门禁。真实产品 MCP 到位后替换 provider/session client，不改变三工具、capability ID、凭证 generation 或审批协议。
