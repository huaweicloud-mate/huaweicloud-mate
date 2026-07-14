# ADR-0015：最小 Install-State 状态信封

状态：Accepted
日期：2026-07-14

## 背景

ADR-0011、0013 和 0014 已分别产生运行时清单摘要、宿主配置事务证据和宿主资产 tree hash。继续实现安装编排前，需要先把这些结果收敛为严格、可比较的最小状态；否则失败回滚、幂等重试和未来受管升级没有可信 ownership 边界。

## 决策

1. 状态固定写入 runtime 根目录的 `install-state.json`，`schemaVersion` 为数字 `1`。文件最大 1 MiB，使用 UTF-8 严格 JSON、精确字段集合、固定四宿主 ID、唯一且排序的 hosts，以及权限受限的 `0600` 文件。
2. 顶层只记录插件版本、安装清单 SHA-256、版本目录、稳定 launcher 和宿主证据，不记录 credentials、审批 receipt、route token、临时 session 或尚不存在的 KooCLI 路径。
3. 每个宿主记录固定 config path、`huaweicloud-agent` entry、merge strategy、canonical value hash、固定 approval issuer，以及资产类型、目标、tree hash 和本次创建路径。
4. 配置型宿主额外保留配置事务的完整文件 hash、创建标记和可选备份证据。Codex/Claude 的 `.mcp.json` 已属于插件 tree hash，不再重复记录为独立配置事务，避免双重 ownership 和双重回滚。
5. 状态只能由安装计划与已完成事务结果构造；host/source/target/config/value hash 任一不匹配都拒绝生成。状态读写还会使用记录的安装清单摘要复验整个版本目录。
6. 首次写入明确要求旧状态不存在，并使用同目录临时文件、`fsync` 和无覆盖 hard-link 激活。替换必须携带此前读取的状态 SHA-256，提交前再次比较；相同内容幂等返回且不改写文件，已有内容使用同目录原子 rename。
7. 状态事务结果保留安装前精确字节与 hash。回滚只在当前 hash 仍等于本次安装结果时执行；新建状态先 quarantine 并二次复核，既有状态恢复精确旧字节。检测到竞态或外部修改时保留现场并返回冲突。

## 安全边界

install-state 是本地协调与 ownership 证据，不是抵抗同账号任意写入者的真实性证明。未来卸载或升级不得仅凭文件内的绝对路径删除内容，仍必须重新生成内置宿主计划、绑定 active runtime，并复核配置/资产当前 hash。

普通文件系统在“检查旧 hash”和原子替换之间没有跨平台 CAS；实现延续 ADR-0013 的边界，把窗口压到提交前并对首次创建与回滚删除使用无覆盖/quarantine 保护，但不引入密码、daemon、锁服务或 v0.2 的复杂隔离设计。

## 当前限制

- 本 ADR 只实现状态构造、严格读取、幂等/CAS 写入和安全回滚，不串联真实宿主安装流程。
- 尚未实现跨 runtime/config/assets 的完整失败回滚编排、受管目录升级、卸载、宿主注册/可发现性验证或 `install/uninstall` CLI。
- KooCLI 尚未落地，因此 v1 状态不写占位路径或虚假 source；后续真实集成需通过显式 schema 演进加入。

## 未采用

- 不把 install-state 演进为通用 receipt、迁移日志、事件流或 drift 数据库。
- 不持久化回滚过程中的临时字节、审批回执或密钥材料。
- 不允许 blind overwrite、`--force` 或根据状态文件中的任意路径直接递归删除。
