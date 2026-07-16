#!/usr/bin/env python3
"""
capability_index.json 生成器 — 从 KooCLI 自动扫描全量服务

用法:
  python3 scripts/build-capability-index.py [--hcloud PATH] [--output PATH]

默认:
  hcloud: ~/.hcloud-agent/koocli/current/hcloud
  output: data/capability_index.json

流程:
  1. hcloud --help → 提取所有服务名 (210+)
  2. hcloud {service} --help → 提取 Available Operations
  3. 每个 operation 分类 risk (read/cost/write/destructive)
  4. 生成 capabilityId: huaweicloud.{product}.{resource}.{action}.v1
  5. 构建 search_index (中文分词索引)
  6. 写入 data/capability_index.json

注意:
  - 首次运行约 50 秒 (211 次 hcloud 调用)
  - MCP Server 条目需另外从 MetaMCP tools/list 补充
"""
import subprocess
import json
import re
import time
import sys
from pathlib import Path

# ─── 配置 ────────────────────────────────────────────────────

HCLOUD_DEFAULT = str(Path.home() / ".hcloud-agent" / "koocli" / "current" / "hcloud")
OUTPUT_DEFAULT = str(Path(__file__).resolve().parent.parent / "data" / "capability_index.json")

# ─── 分类函数 ────────────────────────────────────────────────

def classify_risk(op_name: str) -> str:
    op_lower = op_name.lower()
    if any(k in op_lower for k in ['delete', 'remove', 'terminate', 'destroy', 'unsubscribe', 'recycle']):
        return 'destructive'
    if any(k in op_lower for k in ['create', 'add', 'run', 'execute', 'start', 'restart', 'resize', 'batchcreate']):
        return 'cost'
    if any(k in op_lower for k in ['update', 'modify', 'change', 'stop', 'reboot', 'reset', 'attach', 'detach', 'associate', 'disassociate', 'batch']):
        return 'write'
    return 'read'

def infer_resource(op_name: str, service: str) -> str:
    op = op_name
    prefixes = ['Batch', 'List', 'Get', 'Describe', 'Show', 'Create', 'Delete', 'Update', 'Modify', 
                'Change', 'Add', 'Remove', 'Execute', 'Check', 'Enable', 'Disable', 'Cancel', 
                'Run', 'Stop', 'Start', 'Restart', 'Register', 'Unregister', 'BatchCreate', 'BatchDelete']
    for p in sorted(prefixes, key=len, reverse=True):
        op = re.sub(f'^{p}', '', op)
    op = op.strip('s').strip('_')
    if not op or len(op) < 2:
        return service.lower()
    resource = re.sub(r'([A-Z])', r'_\1', op).lower().strip('_')
    return resource or service.lower()

def infer_action(op_name: str) -> str:
    op = op_name.lower()
    if any(k in op for k in ['delete', 'remove', 'terminate', 'destroy']): return 'delete'
    if any(k in op for k in ['create', 'add', 'register', 'run', 'execute']): return 'create'
    if any(k in op for k in ['update', 'modify', 'change', 'edit', 'upgrade']): return 'update'
    return 'list'

# ─── 主流程 ──────────────────────────────────────────────────

def main(hcloud_path: str, output_path: str):
    print(f"[builder] Using hcloud: {hcloud_path}")
    print(f"[builder] Output: {output_path}")

    # 1. 获取所有服务名
    print("[builder] Step 1: Discovering services...")
    result = subprocess.run([hcloud_path, "--help"], capture_output=True, text=True, timeout=15)
    services = []
    for line in result.stdout.split('\n'):
        name = line.strip()
        if name and re.match(r'^[A-Z][A-Za-z0-9_]+$', name) and not name.startswith('KooCLI'):
            if name not in ['Usage', 'Service']:
                services.append(name)
    print(f"[builder] Found {len(services)} services")

    # 2. 扫描每个服务的 operation
    print("[builder] Step 2: Scanning operations...")
    catalog = {}
    by_product: dict[str, list[str]] = {}
    by_action: dict[str, list[str]] = {}
    search_index: dict[str, list[str]] = {}

    processed = 0
    for svc in services:
        try:
            r = subprocess.run([hcloud_path, svc, "--help"], capture_output=True, text=True, timeout=10)
            output = r.stdout + r.stderr

            if 'Available Operations' not in output:
                continue

            ops_section = output.split('Available Operations:')[1].split('\n\n')[0] if 'Available Operations:' in output else ''
            for line in ops_section.split('\n'):
                op = line.strip()
                if not op or not re.match(r'^[A-Z][A-Za-z0-9]+$', op):
                    continue

                product = svc.lower()
                resource = infer_resource(op, svc)
                action = infer_action(op)
                risk = classify_risk(op)
                cap_id = f"huaweicloud.{product}.{resource}.{action}.v1"

                catalog[cap_id] = {
                    "capabilityId": cap_id,
                    "product": product,
                    "resource": resource,
                    "action": action,
                    "summary": f"{svc} {op}",
                    "risk": {"level": risk},
                    "scope": {"account": "required", "project": "required", "region": "required"},
                    "executors": {
                        "koocli": {
                            "service": svc,
                            "operation": op,
                            "params": {"required": ["region"], "optional": [], "defaults": {}},
                            "status": "available"
                        }
                    }
                }

                by_product.setdefault(product, []).append(cap_id)
                by_action.setdefault(action, []).append(cap_id)

                for kw in {product, resource, action, svc.lower()}:
                    search_index.setdefault(kw, []).append(cap_id)

            processed += 1
            if processed % 20 == 0:
                print(f"  [{processed}/{len(services)}]")

        except Exception as e:
            continue

    print(f"[builder] Processed {processed}/{len(services)} services")
    print(f"[builder] Generated {len(catalog)} capabilities across {len(by_product)} products")

    # 3. 合并已有 MCP 条目（如存在）
    try:
        with open(output_path) as f:
            existing = json.load(f)
            for cid, entry in existing.get("catalog", {}).items():
                if cid not in catalog and entry.get("executors", {}).get("mcp"):
                    # 保留有 MCP executor 但无 KooCLI executor 的条目
                    catalog[cid] = entry
            print(f"[builder] Merged {len(existing.get('catalog', {}))} existing entries")
    except FileNotFoundError:
        print("[builder] No existing catalog to merge")

    # 4. 写入
    output = {
        "capability_index_version": "1.0.0",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": f"KooCLI auto-discovery (v{get_kc_version(hcloud_path)})",
        "catalog": catalog,
        "by_product": by_product,
        "by_action": by_action,
        "search_index": {k: list(set(v)) for k, v in search_index.items()},
    }

    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size_mb = len(json.dumps(output)) / 1024 / 1024
    print(f"[builder] ✅ Written {output_path} ({size_mb:.1f}MB)")

def get_kc_version(hcloud_path: str) -> str:
    try:
        r = subprocess.run([hcloud_path, "version"], capture_output=True, text=True, timeout=5)
        m = re.search(r'(\d+\.\d+\.\d+)', r.stdout)
        return m.group(1) if m else "unknown"
    except:
        return "unknown"

if __name__ == "__main__":
    hcloud = sys.argv[1] if len(sys.argv) > 1 else HCLOUD_DEFAULT
    output = sys.argv[2] if len(sys.argv) > 2 else OUTPUT_DEFAULT
    main(hcloud, output)
