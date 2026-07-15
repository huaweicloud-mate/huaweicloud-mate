# ADR-0046：KooCLI 安全 Adapter 与受信调用边界

状态：Accepted
日期：2026-07-15

后续状态：KooCLI 五平台制品由 ADR-0048 绑定；用户认证由 ADR-0049 收敛为永久 AK/SK。Windows `7.2.12` 实测证明覆盖 HOME/USERPROFILE 不能隔离 `~/.hcloud`；用户随后通过 ADR-0050 明确授权无配置 argv invoker。Adapter 无秘密接口和持久/用户 profile 禁令继续有效。

## 背景

Router 已具备 MCP 优先、KooCLI 补位和执行器锁定逻辑，KooCLI 也已具备兼容系统版本发现与私有固定制品安装门禁，但没有实现 `RouterExecutorAdapter`。ADR-0028 同时禁止在未证明安全契约前把 AK/SK 放入 argv、普通环境变量、临时工作区或持久 profile，因此不能用直接启动 `hcloud` 的不安全实现冒充完成。

## 决策

1. 新增固定 `koocli` Adapter。它只接受 capability 内置的 service/operation、已经过 schema 校验的结构化 arguments、scope、credential generation、预期 account ID 和 correlation ID；调用对象中没有 AK/SK、Authorization、session token 或 profile 路径。
2. 真正接触凭证并启动 KooCLI 的部分抽象为随包受信 `KooCliSecureInvoker`。只有兼容 KooCLI 已发现且 invoker 明确报告可用时，Adapter 才返回 `isAvailable=true`。正式 invoker 未绑定时 Router 会在执行前跳过 KooCLI，云调用保持 fail closed。
3. Adapter 在调用前再次发现/复核系统或私有 KooCLI，拒绝 capability 外映射、credential-shaped 参数键、循环/非 JSON/超限参数；传递绝对可执行路径与固定 service/operation，不构造 shell 字符串。
4. invoker 必须返回结构化 JSON 结果、有效账号、region/project 和可选 request ID。Adapter 在结果进入 Router 前执行大小、账号和 scope 精确匹配；Router 继续负责 output schema、敏感路径脱敏和 credential-like 内容兜底拒绝。
5. 受信边界只返回固定错误分类。read 超时归一为可重试 `UPSTREAM_TIMEOUT`；write 超时与明确结果未知归一为不可重试 `OUTCOME_UNKNOWN`；权限、冲突、限流、scope、账号和验证错误使用冻结 Router 错误码，不回显原始 stderr、命令或堆栈。
6. Development runtime 注册该 Adapter，但默认不注入 invoker。产品 MCP 健康时仍优先；只有它执行前不可用、capability 同时声明 KooCLI 映射且安全 invoker 可用时才选择 KooCLI。开始 dispatch 后不自动切换执行器。

## 结果

- Router 的第二执行器选择、固定映射、输入/输出边界和错误语义已落地并可独立测试。
- 自动化证明未提供 invoker 时不可用、请求不含凭证材料、产品 MCP 执行前不可用时才补位，以及 timeout/`OUTCOME_UNKNOWN`、账号/scope/大小失配 fail closed；执行前补位还作为第 4 个真实状态机向量进入构建后 contract doctor，deferred 保持 0。
- 本 ADR 当时未授权真实 KooCLI 云调用；制品与凭据执行边界后来分别由 ADR-0048/0050 完成。首个真实 capability mapping 与最小权限账号验收仍是发布输入。
