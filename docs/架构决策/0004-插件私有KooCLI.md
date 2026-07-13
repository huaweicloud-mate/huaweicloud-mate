# ADR-0004：插件私有、版本锁定的 KooCLI

- 状态：Accepted
- 日期：2026-07-13

## 决策

Installer 根据 OS/CPU 从批准的华为云官方分发地址下载固定版本 KooCLI，验证 SHA-256 后安装到插件私有版本目录。Core 以绝对路径和参数数组调用。

## 原因

- 避免管理员权限和系统 PATH 依赖。
- 保证各 Agent 使用同一已验证版本。
- 支持原子升级、上一版本回退和供应链审计。

## 结果

- 安装包需要维护可信的 KooCLI release manifest。
- 禁止运行期自动下载 `latest`。
- 是否额外把原生 `hcloud` 暴露到开发者 PATH，另行决定。
