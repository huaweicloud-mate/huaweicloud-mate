# ADR-0020：Codex CLI 激活证据与保守回滚

状态：Accepted
日期：2026-07-14

## 背景

ADR-0018 与 ADR-0019 已完成 Codex 个人 marketplace 文件、插件资产、install-state 和首装失败回滚，但尚未调用 Codex CLI 建立真实安装缓存与启用状态。仅凭 marketplace entry 不能证明 Codex 已安装并启用插件，也无法让提交前宿主发现闭环在真实首装中成立。

Codex 官方命令参考已明确 `codex plugin add/list/remove` 均支持 `--json`；`list --json` 返回 installed/available 数组及插件 identity、marketplace、版本、installed/enabled、source 等证据，`remove --json` 会从本地配置和缓存移除插件。该结构化接口足以建立最小、可验证的激活事务。

## 决策

1. Codex 首装顺序扩展为：插件资产 → 个人 marketplace 文件 → `codex plugin add huaweicloud-mate@<marketplace> --json` → 结构化列表复核 → 全部宿主验证 → install-state。
2. 激活前固定执行 `codex plugin list --marketplace <marketplace> --json`。若同 identity 已安装且启用，本次记录 `changed: false`，不调用 add，也不声称卸载 ownership。
3. 若同 identity 已安装但被用户禁用，返回冲突，不自动启用或覆盖用户选择。重复 identity、畸形 JSON 或缺少必要字段同样 fail closed。
4. add 的退出码不是唯一事实来源。无论 add 成功、非零退出或 runner 抛错，均以紧随其后的结构化 list 作为提交后条件：精确 identity 已安装并启用才算成功；明确不存在则失败；无法读取或状态矛盾则返回 `CODEX_ACTIVATION_OUTCOME_UNKNOWN`。
5. 激活证据记录 `pluginId`、固定插件名、marketplace、版本、完整 installed entry 的 canonical SHA-256、installed/enabled 和本次是否改变。install-state 将该证据嵌入 Codex registration，并重新绑定 marketplace 名称。
6. 首装后续步骤失败时，Codex 单宿主按 CLI 激活、marketplace、插件资产逆序回滚。只有本次 `changed: true` 才允许调用 `codex plugin remove ... --json`。
7. remove 前重新读取结构化列表并要求当前 installed entry hash 与安装后证据完全一致；已不存在视为幂等完成，证据变化则拒绝删除。remove 后再次 list，只有精确 identity 已不存在才算回滚完成。
8. CLI 激活结果未知，或激活无法安全回滚时，保留 marketplace 和插件资产，避免留下安装缓存/配置引用缺失来源；其他宿主仍继续独立回滚。
9. 自动化测试只使用内存状态的假 command runner 与临时 home，不调用本机真实 `codex plugin add/remove`，不修改真实 Codex 配置或缓存。

## 结果

- Codex 的文件注册、CLI 激活、提交前验证和 install-state 已形成单宿主首装闭环。
- 预先存在的启用安装、用户禁用状态、add 非零但后置条件成立、结果未知、证据漂移和 remove 非零但后置条件成立均有自动化覆盖。
- `codex plugin list` 的宿主发现改用 JSON，避免依赖人类可读输出分词。

## 安全边界与当前限制

list 前后取证无法消除另一个同账号进程在极短窗口内安装完全相同 identity/版本/source 的理论竞态；当前以精确 installed entry hash 和保守回滚约束影响，不引入 v0.2 式常驻协调服务或通用注册 SPI。

本 ADR 只定义首装中的 Codex 激活及失败补偿；面向用户的入口、安全卸载和路径重新绑定已由 ADR-0021 补齐。

## 依据

- [Codex developer commands：`codex plugin`](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-plugin)

## 未采用

- 不解析非结构化 `codex plugin list` 文本。
- 不在用户已禁用插件时自动重新启用。
- 不因 add/remove 单次退出码直接认定最终状态。
- 不在结果未知或证据变化后继续删除 marketplace、插件资产或用户安装。
- 不引入后台 daemon、全局安装锁或通用宿主注册框架。
