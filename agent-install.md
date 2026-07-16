# 华为云 Agent 插件安装指南

本指南供 Agent 在 Windows、Linux AMD64 或 Linux ARM64 上执行华为云 Agent 插件安装。它不要求用户理解 Agent 类型、MCP 配置文件或安装命令。

## 当前：私有仓开发验证阶段

仓库尚未公开，用户的 Agent 无法通过公开 URL 读取本指南。因此用户应直接发送以下提示词：

```text
请为当前环境安装华为云 Agent 插件。执行 `npx -y @hd_vector/huaweicloud-meta install --agent auto`，并完成验证。
不要要求我在聊天中发送 AK/SK，也不要在没有交互 TTY 的 Agent shell 中执行凭证或 KooCLI 初始化。
如发现旧的 huaweicloud-mate MCP 配置，请说明差异并让我选择更新或保留。完成后告诉我是否需要重启或新开会话。
```

## 开源发布后的用户提示词

开源仓库和 npm 包正式发布后，将 README 中的占位 URL 替换为公开 Raw GitHub 安装指南 URL。此时用户只需发送：

```text
请阅读并严格执行华为云 Agent 插件安装指南：<PUBLIC_AGENT_INSTALL_GUIDE_URL>
```

用户提示词不得包含 Agent 名称、命令、AK/SK 或配置文件细节。

## Agent 执行要求

1. 执行 `npx -y @hd_vector/huaweicloud-meta install --agent auto`，先完成 KooCLI 二进制和 MCP 配置安装。
2. 通过运行环境自动选择内部 Agent 适配器；若识别失败，Agent 自行选择其宿主适配器重试，不能要求用户判断。
3. AK/SK、默认 Region、Project ID 仅能在用户可见的安全交互终端中输入，不能在聊天、项目文件、配置文件或日志中索取/记录。没有这类输入通道时，必须将凭证配置标记为待完成，不能让它阻断插件安装或假称已完成。Linux 优先使用系统密钥环；密钥环不可用时，必须说明 owner-only `600` 文件兜底的风险并取得用户确认。
4. 如发现旧的 `huaweicloud-mate` MCP 配置，说明差异并等待用户选择更新或保留。
5. 安装后确认 KooCLI、MCP 配置和本地凭证配置结果，并提示用户重启或新开会话（若当前 Agent 需要）。

## 开源发布前检查

- [ ] 将 `<PUBLIC_AGENT_INSTALL_GUIDE_URL>` 替换为公开 Raw GitHub URL。
- [ ] 在未登录浏览器中验证该 URL 可访问。
- [ ] 将 README 的“Agent 协助安装”默认提示词切换为“阅读并严格执行安装指南”。
- [ ] 从目标 npm registry 安装并验证包内的 `agent-install.md` 与公开指南内容一致。
