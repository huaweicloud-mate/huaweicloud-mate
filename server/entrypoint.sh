#!/bin/bash
set -e

mkdir -p ~/.hcloud

# hcloud CLI 格式 (config.json)
echo 'y' | hcloud configure set --cli-profile=default \
  --cli-access-key=${HW_ACCESS_KEY} \
  --cli-secret-key=${HW_SECRET_KEY} \
  --cli-region=cn-south-1 2>/dev/null || true

# huaweicloud-mate 兼容格式 (credentials 文件)
cat > ~/.hcloud/credentials << EOF
[default]
huaweicloud_access_key = ${HW_ACCESS_KEY}
huaweicloud_secret_key = ${HW_SECRET_KEY}
EOF

hcloud configure list 2>/dev/null || true

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
