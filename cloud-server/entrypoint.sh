#!/bin/bash
set -e

mkdir -p ~/.hcloud
cat > ~/.hcloud/credentials << EOF
[default]
huaweicloud_access_key = ${HW_ACCESS_KEY}
huaweicloud_secret_key = ${HW_SECRET_KEY}
EOF

hcloud configure list 2>/dev/null || true

opencode serve --port 3005 --hostname 127.0.0.1 &
OP_SERVER=$!

for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:3005/global/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

curl -s -X POST http://127.0.0.1:3005/mcp \
  -H "Content-Type: application/json" \
  -d '{"name":"mate-npx","config":{"type":"local","command":["npx","-y","huaweicloud-mate"],"enabled":true}}'

echo "[sandbox] ready"

wait $OP_SERVER
