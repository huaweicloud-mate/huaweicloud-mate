#!/bin/bash
set -e

mkdir -p ~/.hcloud

# 拉取 skills（可选，curl 下载 tar.gz，失败不影响沙箱启动）
if [ ! -f /skills/.skills-ready ]; then
  curl -fsSL --connect-timeout 10 https://github.com/huaweicloud/huaweicloud-skills/archive/refs/heads/master.tar.gz -o /tmp/skills.tar.gz 2>/dev/null && \
    tar xzf /tmp/skills.tar.gz -C /tmp/ 2>/dev/null && \
    cp -r /tmp/huaweicloud-skills-master/skills/* /skills/ 2>/dev/null && \
    rm -rf /tmp/skills.tar.gz /tmp/huaweicloud-skills-master || true
  touch /skills/.skills-ready
fi

# 配置 hcloud CLI（长期凭证 或 临时凭证）
if [ -n "${HW_SECURITY_TOKEN}" ]; then
  hcloud configure set \
    --cli-access-key="${HW_ACCESS_KEY}" \
    --cli-secret-key="${HW_SECRET_KEY}" \
    --cli-security-token="${HW_SECURITY_TOKEN}" \
    --cli-region="cn-south-1" 2>/dev/null || true
else
  hcloud configure set \
    --cli-access-key="${HW_ACCESS_KEY}" \
    --cli-secret-key="${HW_SECRET_KEY}" \
    --cli-region="cn-south-1" 2>/dev/null || true
fi

# 接受隐私协议,避免后续每次运行都弹交互提示
sed -i 's/"agreePrivacy": "false"/"agreePrivacy": "true"/' ~/.hcloud/config.json 2>/dev/null || true

# 不创建 credentials 明文文件,仅用 hcloud configure 加密存储
chmod 600 ~/.hcloud/config.json 2>/dev/null || true

# opencode 配置(1.18.x 不支持 mcpServers 键,仅保留基础配置)
mkdir -p ~/.config/opencode
echo '{}' > ~/.config/opencode/opencode.jsonc

opencode serve --port 3005 --hostname 0.0.0.0 &
OP_SERVER=$!

STARTED=false
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:3005/global/health > /dev/null 2>&1; then
        STARTED=true
        break
    fi
    sleep 1
done

if [ "$STARTED" = false ]; then
  echo "[sandbox] opencode startup timeout"
  exit 1
fi

echo "[sandbox] ready"

wait $OP_SERVER
