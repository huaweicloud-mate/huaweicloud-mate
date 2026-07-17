# huaweicloud-mate-codex

华为云 Codex 插件 — 一行命令完成安装配置。

## 安装

```bash
npx huaweicloud-mate-codex
```

自动完成:

1. 安装 huaweicloud-mate
2. 检测 Codex
3. 配置 `~/.codex/mcp.json`
4. 引导配置凭证

## 配置凭证

```bash
mkdir -p ~/.hcloud
cat > ~/.hcloud/credentials << 'EOF'
[default]
huaweicloud_access_key = YOUR_AK
huaweicloud_secret_key = YOUR_SK
huaweicloud_region = cn-north-4
EOF
chmod 600 ~/.hcloud/credentials
```

## 使用

重启 Codex，然后：

```bash
# 在 Codex 中输入:
检查 huaweicloud-mate 的连接状态
搜索 VPC 子网有哪些操作
搜索 ECS 云服务器的查询和创建操作
用 MCP 路径查询 OBS 桶列表，限制 3 条
```

## 与 huaweicloud-mate 的关系

```
huaweicloud-mate-codex (本插件)
  └── huaweicloud-mate (依赖, 自动安装)
        └── Router → MCP/KooCLI → 华为云 210 产品
```

本插件只是一个 Codex 配置安装器 + 启动引导。
核心能力由 huaweicloud-mate 提供。
