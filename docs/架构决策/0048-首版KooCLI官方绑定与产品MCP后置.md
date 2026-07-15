# ADR-0048：首版 KooCLI 官方绑定与产品 MCP 后置

状态：Accepted
日期：2026-07-15

## 背景

用户确认首版正式 KooCLI 使用华为云官方《快速安装/概述》页面列出的安装包；真实产品 MCP 暂不接入，但必须保留后续静态接入口。官方页面提供 Windows amd64、Linux amd64/arm64、macOS amd64/arm64 五个平台包和各自 SHA-256 文件，下载对象位于官方 OBS `/cli/latest/` 路径。

这取代 ADR-0028 中“必须等待版本化不可变 URL”以及“首版必须接入真实产品 MCP”的未完成前提，但不降低摘要校验、凭证隔离、三工具协议或审批边界。

## 决策

1. 私有 KooCLI 固定为 `7.2.12`，系统预装兼容范围仍为 `>=7.2.2 <8.0.0`。
2. release manifest 只接受华为云官方 host 上五个精确的 `/cli/latest/huaweicloud-cli-*` 路径，不接受其他 host、文件名、查询参数、fragment 或重定向。
3. `latest` 只表示上游对象位置，不表示运行时自动更新。插件内置本次取证的 SHA-256；上游替换对象后，旧插件下载会摘要失配并 fail closed，必须由新的插件版本重新取证并更新全部绑定。
4. 当前五个平台绑定为：

| 平台 | 格式 | SHA-256 |
| --- | --- | --- |
| Windows amd64 | ZIP | `c075509737ba63fa62b22b326f13655adcd92bc54b9ce0b7d1a0b25e5af7329e` |
| Linux amd64 | tar.gz | `c0966baeb3975efb3e24f004b16a000919e509ebbb2262ab18690a008aa0d25e` |
| Linux arm64 | tar.gz | `5726da5bfa1cb48ff093d808280d4ed581db0db287e41fad982ab01ef30fbe93` |
| macOS amd64 | tar.gz | `42b258057963d847e6f7fcdd17e05b5a72f776de49f41e689ff4cc115650d69f` |
| macOS arm64 | tar.gz | `17ff6dbf0375706d6c511e4e299672fce95e13d2c74b413b831753d22f463b68` |

5. 五个同名官方区域镜像制品已实际下载并计算摘要，均与官方 `.sha256` 文件一致；Windows amd64 解包后原生命令报告 `7.2.12`。正式 Windows binding 还通过项目私有安装器完成了摘要校验、安全解包、原子提交和版本复验，得到 executable SHA-256 `f2cabaa077dd6eaa05973f304dda9bcbba5eec01dd5fa988267ad9d6c9340748`。
6. 真实产品 MCP 不作为首版发布输入。首版使用内置本地 OBS provider 提供已实现的 OBS 能力，并保留静态 Provider descriptor、Streamable HTTP client、credential-session、health/version/schema digest 和 MCP 优先路由接口；后续接入真实产品 MCP 只通过新插件版本完成，不增加 Router Tool 或动态 Registry。
7. 本 ADR 当时不改变 KooCLI 安全调用边界；其中 argv 禁令后来由用户明确授权的 ADR-0050 取代。普通凭据环境变量和持久 profile 禁令继续有效。

## 结果

- 五平台正式制品来源与摘要不再是首版空缺；
- 上游 `latest` 更新不会让已发布插件静默执行新字节；
- Windows 版本探测后的短暂 `EPERM/EBUSY` 只在原子目录提交时执行有界退避；目标已存在、摘要或 ownership 冲突仍立即 fail closed；
- 真实产品 MCP 的 owner、endpoint 和 session 责任人移至后续集成清单，不再阻塞首版；
- KooCLI argv invoker 后由 ADR-0050 完成；首版仍需首个真实 capability、真实最小权限账号验收、码道/四宿主隔离和 npm 发布身份。

来源：[华为云 KooCLI 快速安装概述](https://support.huaweicloud.com/qs-hcli/hcli_02_003.html)
