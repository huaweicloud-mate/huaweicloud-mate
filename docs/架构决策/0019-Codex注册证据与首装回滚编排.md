# ADR-0019：Codex 注册证据与首装回滚编排

状态：Accepted
日期：2026-07-14

## 背景

ADR-0018 已实现独立的 Codex 个人 marketplace 文件事务，但尚未进入 install-state 或 ADR-0016 的首装协调器。若资产物化后注册失败，或注册成功后验证/状态提交失败，必须明确 marketplace、插件资产和其他宿主之间的提交与回滚顺序；否则 install-state 无法为后续安全卸载提供 ownership 证据。

## 决策

1. Codex 首装顺序固定为：物化并复核 `~/plugins/huaweicloud-mate`，应用个人 marketplace 文件事务，再执行全部宿主提交前验证，最后写 install-state。Claude 与配置型宿主流程不变。
2. Codex 的 completed host 必须携带 marketplace transaction result；其他宿主禁止携带该结果。install-state 的 Codex host 必须包含 `registration`，记录固定类型、marketplace 路径与名称、插件路径与 identity、固定 source、安装后文件/entry hash，以及本次是否改变、是否创建和可选备份证据。
3. `registration.changed: false` 表示完全一致的 entry 在首装前已经存在，状态只记录验证结果，不声称拥有或可删除该 entry，也不保留无意义的 before/backup 字段。
4. install-state 重新绑定 `registration.pluginPath` 与同一 host 的插件 asset target，并重新推导默认个人 marketplace 路径；缺少 registration、路径重定向、source/identity 变化、摘要畸形或 ownership 字段不一致均拒绝。
5. 首装失败时按宿主逆序处理。Codex 单宿主内先回滚 marketplace，再回滚插件资产；只有 marketplace 已恢复或本次没有写入，才允许删除本次插件资产。
6. 若 marketplace 在安装后被用户修改而不能安全回滚，保留 marketplace 和 Codex 插件目录，返回 `INSTALL_TRANSACTION_ROLLBACK_CONFLICT`，避免留下指向已删除源的 entry；其他宿主的配置和资产仍继续独立回滚。
7. marketplace 在应用前已经存在同名冲突时，本次尚未建立注册 ownership，协调器保留原文件并回滚刚物化的 Codex 插件资产。
8. 当前 install-state 仍使用开发期 schema version `1`。尚无已发布状态需要兼容；首个公开版本冻结前必须再次审查 schema 版本与迁移策略。

## 结果

- Codex marketplace、插件资产与 install-state 已形成完整的文件级首装提交/回滚闭环。
- 自动化测试覆盖成功提交、已有一致 entry、同名冲突、最终验证失败、状态提交竞态，以及 marketplace 用户修改导致的依赖保留和其他宿主继续回滚。
- 首装协调器现在会写临时测试 home 下的 marketplace；工程测试仍不接触真实用户目录，也不执行 Codex CLI 激活。

## 安全边界与当前限制

该闭环只证明 marketplace 文件内容和插件资产 ownership，不代表 `codex plugin add` 已成功，不包含 Codex 安装缓存或插件启用状态。提交前 `codex plugin list` 验证仍需要后续可回滚的 CLI 激活事务才能在真实首装中通过。

install-state 不是同账号攻击者不可伪造的真实性证明。后续卸载必须重新生成内置计划、复核 runtime/asset/registration 当前 hash，并在任何用户修改下停止，不能仅凭状态中的绝对路径删除文件。

## 未采用

- 不在 marketplace 回滚冲突后继续删除被其引用的插件目录。
- 不把预先存在的相同 entry 认领为本次创建，也不为此制造备份。
- 不把 Codex CLI 激活、Claude marketplace 或通用宿主注册 SPI 混入本切片。
