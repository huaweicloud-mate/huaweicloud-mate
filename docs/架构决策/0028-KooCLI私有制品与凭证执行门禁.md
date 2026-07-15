# ADR-0028：KooCLI 私有制品与凭证执行门禁

状态：Accepted
日期：2026-07-14

后续状态：制品 URL 与版本绑定部分由 ADR-0048 取代；非 argv 门禁又由用户明确授权的 ADR-0050 取代。持久 profile、普通凭据环境变量和临时参数文件禁令继续有效。

## 背景

Proposed v0.3-lite 要求优先复用兼容的系统 KooCLI，否则安装插件绑定的私有固定版本。与此同时，AK/SK 不得进入命令行、workspace、日志或 KooCLI 的持久 profile。官方公开下载地址当前使用 `/cli/latest/`；官方文档可确认 ZIP/`tar.gz` 制品与 SHA-256 校验文件，但尚未提供本项目可以绑定的五平台不可变对象 URL。现有官方调用资料也只证明命令行参数或持久 profile 凭证方式，不能证明环境变量或标准输入注入契约。

## 决策

1. 兼容范围保持 `>=7.2.2 <8.0.0`，预装兼容版本优先。
2. 私有安装只接受五平台 release manifest 中的官方 HTTPS 不可变对象 URL、固定 `7.2.2` 和内置 SHA-256；任何 `/latest/`、重定向、查询参数或摘要失配均 fail closed。
3. Windows ZIP 与 Linux/macOS `tar.gz` 在进程内解包，不调用 Shell。解包器限制压缩包和可执行文件大小，拒绝路径穿越、链接、多可执行入口、未知 tar 类型和 checksum 失配。
4. 私有 KooCLI 安装到版本化用户目录，使用 staging、绝对路径、原子目录提交、`installation.json` 和可执行文件 hash 复核；不修改系统 KooCLI，不加入 PATH。
5. `doctor --koocli` 明确区分 system、private、binding-missing 与 private-missing。
6. 在拿到可信、非 argv、非持久 profile 的凭证注入契约或受信封装前，KooCLI 云操作 dispatch 保持禁用。不得为了“先跑通”把 AK/SK 放入进程参数、普通环境转储、临时工作区或长期 KooCLI profile。

## 结果

- 私有安装供应链和复用路径可以独立完成并测试。
- release manifest 未绑定时开发态仍可使用本地 OBS Provider，但发布门禁明确失败。
- KooCLI 执行器不能假装已完成；凭证注入证据是启用真实 dispatch 的必要条件。
- 不引入动态 Registry、通用 Adapter SPI 或独立凭证控制面。
