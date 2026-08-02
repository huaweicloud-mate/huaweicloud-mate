#!/bin/bash
set -e

# ── Skills ──
if [ ! -d /skills/.git ]; then
  git clone --depth 1 https://gitcode.com/huaweicloud/huaweicloud-skills.git /tmp/huaweicloud-skills 2>/dev/null && \
    cp -r /tmp/huaweicloud-skills/skills/* /skills/ 2>/dev/null && \
    rm -rf /tmp/huaweicloud-skills || true
fi

# ── hcloud CLI ──
mkdir -p ~/.hcloud
if [ -n "${HW_SECURITY_TOKEN}" ]; then
  hcloud configure set \
    --cli-access-key="${HW_ACCESS_KEY}" \
    --cli-secret-key="${HW_SECRET_KEY}" \
    --cli-security-token="${HW_SECURITY_TOKEN}" \
    --cli-region="${HW_REGION:-cn-south-1}" 2>/dev/null || true
elif [ -n "${HW_ACCESS_KEY}" ]; then
  hcloud configure set \
    --cli-access-key="${HW_ACCESS_KEY}" \
    --cli-secret-key="${HW_SECRET_KEY}" \
    --cli-region="${HW_REGION:-cn-south-1}" 2>/dev/null || true
fi
sed -i 's/"agreePrivacy": "false"/"agreePrivacy": "true"/' ~/.hcloud/config.json 2>/dev/null || true
chmod 600 ~/.hcloud/config.json 2>/dev/null || true

# 软链接到 huaweicloud-mate 期望的 KooCLI 路径
mkdir -p ~/.hcloud-agent/koocli/current/
ln -sf /usr/local/bin/hcloud ~/.hcloud-agent/koocli/current/hcloud

# ── opencode config ──
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.jsonc << EOFCT
{
  "mcp": {
    "huaweicloud-mate": {
      "type": "local",
      "command": ["node", "/opt/huaweicloud-mate/dist/router/index.js"],
      "env": {
        "HW_ACCESS_KEY": "${HW_ACCESS_KEY}",
        "HW_SECRET_KEY": "${HW_SECRET_KEY}",
        "HW_REGION": "${HW_REGION:-cn-south-1}",
        "HW_SECURITY_TOKEN": "${HW_SECURITY_TOKEN:-}",
        "HW_SKILLS_DIR": "/skills",
        "HW_CAPABILITY_INDEX": "/opt/huaweicloud-mate/data/capability_index.json"
      }
    }
  }
}
EOFCT

# ── Start opencode ──
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
