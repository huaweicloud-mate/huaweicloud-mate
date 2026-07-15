# ADR-0049：KooCLI 首版仅使用永久 AK/SK

状态：Accepted
日期：2026-07-15

后续状态：第 5、6 条中的 argv 禁令由用户明确授权的 ADR-0050 取代；永久 AK/SK 单一用户入口、无 SecurityToken/密码/SSO/profile 输入和不覆盖用户 profile 的决策继续有效。

## 背景

用户确认 KooCLI 认证只希望提供 AK/SK，不引入密码、SecurityToken、SSO、ECS Agency、AssumeRole 或 KooCLI profile 名。当前 `auth set` 已通过交互终端非回显读取 AK/SK，并以固定只读请求校验账号身份；credentials v1 也只允许 `accessKey` 与 `secretKey` 两个秘密字段。

KooCLI `7.2.12` 的本机帮助及华为云官方文档表明：永久 AK/SK 可独立完成 AKSK 认证；SecurityToken 只适用于临时 AK/SK。官方公开的无配置方式会把 `cli-access-key` 与 `cli-secret-key` 直接放入命令行，配置方式则把凭据保存到 profile。当前未发现受支持的 stdin 或凭据环境变量调用接口。

## 决策

1. 首版用户凭据固定为一组永久 AK/SK。界面和 CLI 不请求密码、SecurityToken、token、profile 名或其他认证材料。
2. Region、project ID、domain/account ID 是调用 scope 或身份校验结果，不作为用户秘密凭据；插件在能力需要时从 scope、账号校验和固定配置中获得。
3. `auth set` 继续作为唯一录入入口：只允许交互终端非回显输入，禁止通过 CLI 参数、Tool 参数、普通环境变量或日志传入 AK/SK。
4. credentials v1 保持严格字段集合。包含 `securityToken`、密码、profile 或其他未知字段的文件必须 fail closed；不为本决策扩展 schema。
5. KooCLI Adapter 不接收 AK/SK，正式 invoker 也不因本决策自动获得 argv 或持久 profile 授权。未确定安全的内部传递机制前，真实 KooCLI dispatch 继续不可用；内置本地 OBS provider 不受影响。
6. 如果后续选择 KooCLI 专用加密 profile、临时隔离 profile 或命令行无配置模式，必须以新的显式决策记录其磁盘、进程列表、清理和账号隔离风险，不能静默降低 ADR-0046/0048 的门禁。

## Windows 7.2.12 实测补充

在 Windows amd64 KooCLI `7.2.12` 上，以虚构 AK/SK 做了不访问云端的本地配置实验。子进程同时覆盖 `HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH` 和 XDG 目录后，KooCLI 仍使用登录用户的 `~/.hcloud/config.json`；`configure set` 没有在隔离 home 生成配置，后续 `configure init` 也识别到登录用户配置并要求删除已有配置后继续。

因此“通过环境变量重定向到插件私有 home，再用 stdin 初始化默认 profile”在 Windows 首发平台上不可用，相关原型已撤回。插件不得以默认 profile、备份后覆盖用户配置、目录链接或未记录的 KooCLI 内部加密格式绕过该限制。跨平台正式 invoker 仍只有两条候选：等待上游提供受支持的安全注入/配置路径，或由用户另行明确接受无配置方式把 AK/SK 放入子进程 argv 的暴露风险。

## 结果

- 用户只需记住和配置 AK/SK，一套凭据供首版本地 provider 及未来获准的 KooCLI invoker 使用；
- 临时 AK/SK + SecurityToken、SSO 等认证方式不进入首版范围；
- 本决策收敛用户认证体验，但不虚构 KooCLI 尚未提供的安全凭据注入能力。

来源：

- [华为云 KooCLI：无配置方式使用 AK/SK 认证](https://support.huaweicloud.com/usermanual-hcli/hcli_07_002.html)
- [华为云 KooCLI：配置项参数概述](https://support.huaweicloud.com/usermanual-hcli/hcli_03_003_03.html)
