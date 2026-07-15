# ADR-0050：KooCLI 无配置 argv 凭据授权

状态：Accepted
日期：2026-07-15

取代：ADR-0028、ADR-0046、ADR-0048、ADR-0049 中“AK/SK 不得进入 KooCLI 子进程 argv”的发布门禁；其余固定制品、Adapter、profile 隔离和输出门禁继续有效。

## 背景

首版用户认证已经收敛为一组永久 AK/SK，供本地 Provider、未来产品 MCP 和 KooCLI 共用。KooCLI `7.2.12` 官方支持的永久 AK/SK 自动化入口只有：

1. 在无配置命令中传入 `cli-access-key` 与 `cli-secret-key`；
2. 把认证信息保存到 KooCLI profile。

Windows 实测又证明覆盖 HOME/USERPROFILE 不能把 KooCLI profile 隔离到插件目录；初始化默认 profile 会触碰用户已有 `~/.hcloud/config.json`。用户在获知同账号进程列表暴露风险后，明确授权插件采用官方无配置 argv 模式。

## 接受的风险

- AK/SK 会在 `hcloud` 子进程存活期间出现在该子进程命令行；同账号进程、管理员、EDR/进程监控或崩溃采集工具可能读取或留存它。
- 插件无法通过应用层代码消除操作系统或第三方进程监控对 argv 的可见性。
- KooCLI 仍可能按其标准行为读取用户 `~/.hcloud` 的全局设置并维护元数据缓存或错误日志；插件不创建、覆盖或选择用户 profile。

## 决策

1. `KooCliExecutorAdapter` 继续不接收 AK/SK。随包 `AuthorizedArgvKooCliInvoker` 只在 dispatch 前从权限受限 `CredentialStore` 读取当前 generation，并精确比对 account/domain identity。
2. 只以绝对路径、`shell=false`、隐藏窗口和最小环境启动 KooCLI；不通过 PATH、shell、普通凭据环境变量、临时参数文件或 profile 传递秘密。
3. argv 的 service/operation 只能来自静态 capability mapping，API 参数必须已通过 capability schema 和 Adapter 的 credential-shaped key 拒绝；invoker再次拒绝 `cli-*`、调试、交互、dry-run 和帮助参数。
4. 每次调用固定传入 `cli-mode=AKSK`、永久 AK/SK、`cli-retry-count=0`、JSON 输出、HTTPS 证书校验、离线元数据、关闭 warning 和单次隐私声明同意；region、project 与 domain ID只来自已校验 scope/identity。
5. 不传 `cli-profile` 或 SecurityToken，不修改用户 KooCLI profile。单次 argv 上限 24 KiB，进程默认超时 60 秒，stdout+stderr 合计最多 1 MiB。
6. 插件日志、审计、错误和返回值不得记录 argv、AK/SK 或原始 stderr。KooCLI 非零退出只映射为固定错误分类；stdout 回显当前 AK 或 SK 时立即拒绝。
7. KooCLI 内部连接重试固定为 0。read 超时仍由 Router 按既有策略标记可重试；write 超时统一为不可自动重试的 `OUTCOME_UNKNOWN`。
8. 默认 runtime 绑定该 invoker；只有 credentials 已配置、兼容 KooCLI 已发现且 capability 含静态 KooCLI mapping 时才可选。ADR-0051 已新增首个 ECS 只读 mapping；真实云验收仍需最小权限测试账号。

## 验证

- 虚构凭据测试覆盖 argv 构造、无 profile、重试关闭、最小环境、generation/account/domain 失配的进程前拒绝、保留字段拒绝和响应凭据回显拒绝；
- 本机 KooCLI `7.2.12` 已用无凭据 `--help` 解析验证单次 `cli-agree-privacy-statement`、`cli-warning` 和 `cli-offline` 参数可接受，且该检查未改写 `~/.hcloud/config.json`；
- 未使用真实 AK/SK，未执行云 API。

来源：[华为云 KooCLI：无配置方式使用 AK/SK 认证](https://support.huaweicloud.com/usermanual-hcli/hcli_07_002.html)
