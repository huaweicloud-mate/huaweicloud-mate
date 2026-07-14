# ADR-0018：Codex 个人 Marketplace 布局与安全注册文件事务

状态：Accepted
日期：2026-07-14

## 背景

ADR-0012 把 Codex 插件先物化到 runtime 管理目录，ADR-0017 随后把实际 marketplace 注册留给独立事务。Codex 默认个人 marketplace 固定使用 `~/.agents/plugins/marketplace.json`，其中本地插件源必须写成 `./plugins/<plugin-name>`，并解析到 `~/plugins/<plugin-name>`。原先的 `runtime/hosts/codex/huaweicloud-mate` 无法在不复制第二份插件或创建链接的情况下满足这个约定。

## 决策

1. Codex 的稳定 `pluginRoot` 精确绑定为 `~/plugins/huaweicloud-mate`。Claude Code 和其他宿主的既有目标不变；版本化 Router 运行时仍位于 hcloud-agent runtime 根目录，插件中的 `.mcp.json` 继续只引用稳定 launcher。
2. 默认个人 marketplace 文件固定为 `~/.agents/plugins/marketplace.json`，插件 entry 固定为：本地源 `./plugins/huaweicloud-mate`、安装策略 `AVAILABLE`、认证策略 `ON_INSTALL`、分类 `Productivity`。不增加 `policy.products`。
3. 新 marketplace 使用 `name: personal` 和 `interface.displayName: Personal`。已有 marketplace 保留其合法名称、界面元数据、其他插件和未知顶层字段；新 entry 只追加到 `plugins[]` 末尾。
4. 同名 entry 完全一致时幂等，不重写文件；任何同名但 source、policy、category 或额外字段不同的 entry 都视为冲突，不使用 `--force` 覆盖。
5. marketplace 文件只接受不超过 1 MiB 的 UTF-8 严格 JSON、对象根、唯一 property 和唯一插件名。写入采用权限受限备份、同目录临时文件、提交前 hash 比较和原子替换；回滚前再次比较安装后 hash，用户已修改时保留现场并报告冲突。
6. 注册事务在写 marketplace 前验证 `~/plugins/huaweicloud-mate` 是非符号链接目录，且包含 identity 为 `huaweicloud-mate` 的 Codex manifest。插件完整 tree hash 仍由 ADR-0014 的资产事务负责。
7. 本切片只实现可回滚的 marketplace 文件注册，不调用 `codex plugin add`，不改 Codex 配置或缓存，也不把 entry 存在描述为插件已经激活。CLI 激活必须等到其安装/卸载回滚路径被明确验证后再接入首装协调器。

## 结果

- Codex 插件目录与默认个人 marketplace 的固定 source path 一致，不需要维护第二份插件、junction 或 symlink。
- marketplace 新建、追加、幂等、同名冲突、精确恢复、用户修改保护、重复字段和写入竞态都有自动化测试。
- 当前事务是独立模块，尚未扩展 install-state，也尚未进入 ADR-0016 的首装编排；因此不会在开发或测试阶段写入真实用户 marketplace。

## 安全边界与当前限制

本地 SHA-256 和 compare-before-replace 只能约束 Installer 自己的 ownership 与并发写入，不能抵抗同账号任意代码执行，也不能证明 Codex 已加载插件。CLI 激活、缓存更新、卸载命令、真实 `codex plugin list` 闭环和 Codex App 新任务加载仍待后续切片完成。

Claude Code 使用不同的 marketplace 与插件缓存机制，不复用本 ADR 的文件格式或路径；后续只实现 Claude 专用的最小注册流程，不引入通用 Adapter SPI。

## 未采用

- 不保留旧 runtime 下的 Codex pluginRoot 再复制到 `~/plugins`。
- 不使用 symlink、junction、`--force` 或手工缓存修改绕过个人 marketplace 约定。
- 不把 Codex 与 Claude 的 marketplace 抽象成动态注册平台。
