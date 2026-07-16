#!/usr/bin/env bash
# huaweicloud-mate 端到端测试
# 测试: Router 5 工具 + MCP 直连 (mock) + KooCLI health

set -e
cd "$(dirname "$0")/.."

echo "========================================"
echo "  huaweicloud-mate E2E Test"
echo "========================================"

ROUTER="node dist/router/index.js"

send() {
  printf '%s\n' "$1" | timeout 5 $ROUTER 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        msg = json.loads(line)
        if 'result' in msg and 'tools' in msg['result']:
            names = [t['name'] for t in msg['result']['tools']]
            print(f'  TOOLS ({len(names)}): {names}')
        elif 'result' in msg and 'content' in msg['result']:
            text = msg['result']['content'][0]['text'][:200]
            print(f'  RESULT: {text}')
        elif 'error' in msg:
            print(f'  ERROR: {msg[\"error\"]}')
    except:
        print(f'  RAW: {line[:100]}')
" 2>/dev/null
}

# ─── Test 1: tools/list ─────────────────────────────────
echo ""
echo "[1/5] tools/list"
send '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# ─── Test 2: cloud_capability_search ────────────────────
echo ""
echo "[2/5] cloud_capability_search('OBS桶')"
send '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cloud_capability_search","arguments":{"query":"OBS桶"}}}'

# ─── Test 3: cloud_capability_describe ──────────────────
echo ""
echo "[3/5] cloud_capability_describe"
send '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cloud_capability_describe","arguments":{"capabilityId":"huaweicloud.obs.bucket.list.v1"}}}'

# ─── Test 4: cloud_targets_status ───────────────────────
echo ""
echo "[4/5] cloud_targets_status"
send '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cloud_targets_status","arguments":{}}}'

# ─── Test 5: cloud_action_execute (MCP path, mock ECS) ──
echo ""
echo "[5/5] cloud_action_execute → MCP mock ECS"
send '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cloud_action_execute","arguments":{"capabilityId":"huaweicloud.ecs.server.list.v1","executor":"mcp","params":{"region":"cn-north-4","limit":3}}}}'

echo ""
echo "========================================"
echo "  E2E Test Complete"
echo "========================================"
