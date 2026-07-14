# ADR-0014：宿主资产 Staging 与 Hash 安全物化

状态：Accepted
日期：2026-07-14

## 背景

ADR-0012 已生成 Codex/Claude 插件资产和单一 Canonical Skill，ADR-0013 已实现宿主配置事务。继续串联 Installer 前，还需要把版本目录中的插件/Skills 安全复制到稳定宿主目录，并确保失败回滚不会删除安装后被用户修改的内容。

## 决策

1. 每次物化前都使用 active runtime 绑定的 `installManifestSha256` 复验整个版本目录。资产源只能是安装计划对应的固定前缀：`host-assets/<host>/plugin` 或 `skills/canonical/huaweicloud`。
2. 源文件必须仍与安装清单中的 size/SHA-256 一致。复制目标是最终目录的同级随机 staging；文件以独占方式写入并 `fsync`，目录和文件均拒绝符号链接。
3. Codex/Claude 源 `.mcp.json` 必须精确包含 `{nodePath}` 与 `{stableLauncherPath}` 两个固定占位值。只在 staging 中把它渲染为安装计划给出的 Node、稳定 launcher 和 `router --stdio`，随后复核 plugin manifest、MCP fragment 与 Canonical Skill。
4. OpenCode/码道只从同一份 canonical source 物化 `huaweicloud/SKILL.md`，不生成长期维护的宿主专用副本。
5. staging 目录通过路径、目录和文件内容生成确定性 tree hash。目标不存在时使用同盘 rename 激活；目标已存在且 tree hash 完全相同则幂等，不同则返回 `HOST_ASSET_CONFLICT`，首版不强制覆盖。
6. 若目标在提交前并发出现，保留该目标、删除 staging 并报告冲突。事务结果记录 `installedTreeHash` 与本次创建的目录路径。
7. 回滚先比较当前 tree hash，再把目录 rename 到同级 quarantine 并复算 hash。若两次 hash 不同，优先恢复 quarantine，返回 `HOST_ASSET_ROLLBACK_CONFLICT`；只有两次都匹配才删除。

## 结果

- 宿主资产不再直接从 npm cache 或未验证目录复制。
- 插件占位配置不会出现在已激活目录；宿主始终引用固定用户目录中的稳定 launcher。
- 安装期并发创建和安装后修改都有 fail-closed 测试，失败回滚不会静默删除用户内容。
- `MaterializedRuntime` 现在显式返回 `installManifestSha256`，供后续安装状态和宿主资产复验使用。

## 限制

- 当前只支持全新创建和内容完全相同的幂等物化。受管目录升级替换必须等最小 install-state 能证明旧 tree hash 后再实现。
- 本 ADR 不注册 Codex/Claude marketplace、不修改宿主配置、不执行宿主可发现性验证，也不开放 `install` CLI。
- 同用户恶意进程仍可攻击普通文件系统的检查/rename 间隙；实现通过提交前冲突检查、激活后 tree hash 和 quarantine 复核缩小影响，但不恢复 daemon、系统服务或 v0.2 的复杂隔离设计。

## 未采用

- 不直接递归覆盖已有插件/Skill 目录。
- 不从网络下载宿主资产，不执行模板脚本，也不接受任意源路径。
- 不引入通用文件事务框架、锁服务或复杂 drift 数据库。
