# ADR-0003：产品 MCP 与 KooCLI 作为同级执行器

- 状态：Accepted
- 日期：2026-07-13

## 决策

产品 MCP 与 KooCLI 都注册到统一 capability catalog，不把任一方固定为另一方的 fallback。Agent 根据用户意图和 Skills 选择 executor，Core 统一校验策略。

## 约束

- plan 创建后锁定 executor。
- 写、删、付费和高权限操作失败后不得自动切换 executor。
- 两种执行器共用 target、凭证引用、region/project、审批、脱敏和审计规则。
- Agent 不能指定任意 MCP endpoint、KooCLI 路径或原始凭证。

## 未决项

- 低风险读操作是否允许 `executor=auto`。
- 四个首版产品是否要求两种 executor 均达到生产可用。
