#!/bin/bash
set -e

mkdir -p ~/.hcloud

# 拉取 skills（已有则跳过）
if [ ! -f /skills/.skills-ready ]; then
  git clone --depth 1 https://gitcode.com/huaweicloud/huaweicloud-skills.git /tmp/skills 2>/dev/null || true
  if [ -d /tmp/skills/skills ]; then
    cp -r /tmp/skills/skills/* /skills/ 2>/dev/null || true
    rm -rf /tmp/skills
    touch /skills/.skills-ready
  fi
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

# huaweicloud-mate 兼容格式
cat > ~/.hcloud/credentials << EOF
[default]
huaweicloud_access_key = ${HW_ACCESS_KEY}
huaweicloud_secret_key = ${HW_SECRET_KEY}
EOF
chmod 600 ~/.hcloud/credentials

opencode serve --port 3005 --hostname 0.0.0.0 &
OP_SERVER=$!

for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:3005/global/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "[sandbox] ready"

wait $OP_SERVER
