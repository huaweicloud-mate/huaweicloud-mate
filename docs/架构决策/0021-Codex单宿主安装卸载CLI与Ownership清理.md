# ADR-0021：Codex 单宿主安装卸载 CLI 与 Ownership 清理

状态：Accepted
日期：2026-07-14

## 背景

ADR-0018 至 ADR-0020 已完成 Codex 插件资产、个人 marketplace、CLI 激活和 install-state 证据，但能力只存在于内部事务层，用户还没有可执行的正式入口。正式卸载也不能把 install-state 中的绝对路径直接视为删除授权，否则状态漂移、用户修改或预先存在的相同资源都可能被误删。

首版当前只需要先打通 Codex 单宿主闭环，不应为尚未接入的其他宿主恢复 v0.2 式通用 Adapter SPI、常驻协调器或复杂 drift/repair 框架。

## 决策

1. 新增 `huaweicloud-mate install --host codex` 与 `huaweicloud-mate uninstall --host codex`，两者支持 `--json`。`--host codex` 必须显式提供；其他宿主在各自注册流程完成前拒绝执行。
2. install 先物化并复验版本化运行时，再从该已验证版本加载宿主模板与契约，生成 Codex 固定路径计划，随后复用既有资产、marketplace、CLI 激活和 install-state 首装事务。
3. install 提交 install-state 前必须通过稳定 launcher 版本冒烟、Codex 结构化插件列表发现和一次无云副作用的受信审批探针。审批只需要点击批准或拒绝，不输入密码；安装流程不读取凭证，也不执行云操作。
4. uninstall 在运行时根或 install-state 不存在时返回幂等的 `not-installed`。当前只接受仅含 Codex 的 install-state；混合宿主状态拒绝由单宿主入口修改。
5. uninstall 使用 install-state 绑定的已验证版本重新加载内置 Codex 模板，并结合当前 home 重新推导插件、`.mcp.json` 和个人 marketplace 固定路径。marketplace 备份路径还必须位于运行时私有 `backups/codex-marketplace` 目录；状态中的任意重定向路径均拒绝使用。
6. 删除前对所有本次拥有的资源执行只读预检。CLI activation、marketplace 和插件 tree 必须仍与安装后 identity/hash 完全一致，或者已经满足回滚后的幂等状态；任一资源漂移时不开始删除。
7. 删除顺序固定为 CLI activation → marketplace →插件资产 → install-state CAS 删除。只有证据中 `changed: true` 的资源才允许删除或恢复；`changed: false` 表示安装前已经存在，只验证 ownership 形状但不删除。
8. 资产目录已不存在、安装时新建的 marketplace 已不存在、原 marketplace 已恢复，以及 Codex plugin 已不存在，都视为可重试的完成状态。该幂等性只服务有限安装/卸载补偿，不演进为独立 repair 或通用迁移日志。
9. uninstall 保留已验证版本化 runtime 和 credentials。runtime 可供后续重装或诊断复用；凭证只能由未来显式 `auth remove` 清理。
10. 自动化测试只在临时 home、临时 runtime 和假 Codex runner 中执行，不调用真实 `codex plugin add/remove`，不修改开发机 Codex 配置或缓存。

## 结果

- Codex 已具备首个面向用户的单宿主安装与安全卸载闭环。
- 用户预先存在的相同 plugin asset、marketplace entry 或已启用插件不会被卸载入口认领或删除。
- 用户修改受管资产后，卸载会在任何删除前返回明确冲突并保留现场。
- 自包含 runtime bundle 明确优先依赖的 ESM 入口，新增 installer 依赖后稳定 launcher 仍可独立启动。

## 安全边界与当前限制

当前 `install` 仍是首装事务；存在 install-state 时会要求后续受管升级实现，尚不支持通过重跑 install 原子升级。当前 uninstall 只处理 Codex 单宿主状态，不清理 runtime cache、credentials、日志、KooCLI 或其他宿主资源。

同账号恶意进程理论上仍可在预检和删除之间制造竞态；实际删除原语继续使用 compare-before-remove、结构化后置检查、原子替换或 quarantine 复核来 fail closed。本方案不引入全局锁或常驻 daemon。

## 未采用

- 不提供 `--force` 绕过 hash/identity 冲突。
- 不根据 install-state 中未经重新绑定的绝对路径删除文件。
- 不删除安装前已经存在的相同资源。
- 不把卸载与 credentials 或 runtime cache 清理耦合。
- 不提前开放 Claude、OpenCode 或华为云码道的未完成安装入口。
- 不恢复独立 update/repair、复杂 drift 框架或通用 Adapter SPI。
