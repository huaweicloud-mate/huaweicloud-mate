# ADR-0051：首个 ECS 只读 KooCLI 能力

状态：Accepted
日期：2026-07-15

## 背景

KooCLI 官方制品、永久 AK/SK 认证和受信 argv invoker 已完成，但 catalog 尚无可由 Agent 搜索、描述和执行的真实产品能力。首个切片应验证 Router 与 KooCLI 的真实结构，而不恢复通用 OpenAPI、动态 Registry 或复杂路由。

华为云当前 ECS API 提供 `ListServersDetails`，需要 region 与 project ID，IAM 用户所需权限为 `ecs:cloudServers:listServersDetails`（别名 `ecs:cloudServers:list`）。该接口原始响应含地址、元数据、安全组等详细基础设施信息，不应完整进入 Agent 上下文。

## 决策

1. 静态注册 `huaweicloud.ecs.server.list.v1`，固定映射为 KooCLI `ECS ListServersDetails`；首版不为该能力接入 Provider MCP，默认执行器为 `koocli`。
2. scope 必须同时包含 region 与 project。输入必须提供 `limit`，范围为 1～50；可选 `marker` 必须是 UUID。分页时 marker 与 limit 一起提交。
3. ECS 清单属于敏感基础设施读取，固定标记 `read + sensitive-read` 并要求点击审批；不要求密码。
4. 生产 argv invoker 增加第二层静态调用白名单。当前只允许精确的 `ECS/ListServersDetails`，未知 service/operation 在启动 KooCLI 前失败。
5. `project_id` 只从已校验 scope 生成，用户参数不得重复覆盖；采用 KooCLI API 参数 `--project_id`，不使用配置项名称代替 API path 参数。
6. invoker 固定注入 KooCLI JMESPath 查询，只允许结果进入 Router 前保留 `{count, servers:[{id,name,status}], nextMarker}`。地址、metadata、安全组、flavor、镜像和原始详细响应不进入 Agent 上下文。
7. 单页最多 50 条，Router 输出上限 128 KiB。`nextMarker` 为本页最后一个 server ID；当 `count < limit` 时分页结束，当 `count == limit` 时调用方可用它继续查询。
8. 真实账号调用、最小 IAM 权限、目标 region/project 和 KooCLI 元数据可用性仍是发布验收项；当前只使用虚构凭据和假进程完成无云闭环。

## 验证

- capability 契约测试覆盖 search/describe、固定执行器、scope、风险和无 Provider MCP；
- invoker 测试覆盖正式 `project_id`、固定输出查询、参数冲突和未知 operation 的进程前拒绝；
- Router 端到端测试覆盖预览前零 dispatch、受信点击审批、审批后 AK/SK 释放、固定 argv 与有界结构化输出；
- 未使用真实 AK/SK，未执行云 API。

来源：[华为云 ECS：查询云服务器列表](https://support.huaweicloud.com/api-ecs/ecs_02_0107.html)、[华为云 KooCLI：无配置方式使用 AK/SK 认证](https://support.huaweicloud.com/usermanual-hcli/hcli_07_002.html)
