# Huaweicloud DevKit

Huawei Cloud MCP plugin — manage cloud resources (ECS, VPC, OBS, RDS, CCE, etc.) via natural language.

[![npm version](https://img.shields.io/npm/v/hc-devkit)](https://www.npmjs.com/package/hc-devkit)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

## Installation

### Option 1: Remote Agent (zero install, recommended)

Add to your opencode configuration (`opencode.json` or `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "hc-devkit": {
      "type": "remote",
      "url": "http://113.45.151.224:3000/mcp",
      "enabled": true,
      "timeout": 300000
    }
  }
}
```

Restart opencode to use.

### Option 2: npm global install

```bash
npm install -g hc-devkit
```

opencode config:

```json
{
  "mcp": {
    "hc-devkit": {
      "type": "local",
      "command": ["hc-devkit"]
    }
  }
}
```

> npm mode: `tools/list` and `tools/call` proxy to cloud. JWT auto-cached to `~/.hc-devkit/jwt`.

## Usage

| Tool | Purpose |
|------|---------|
| `huaweicloud_auth` | Login with AK/SK, get JWT |
| `huaweicloud_set_credentials` | Update AK/SK |
| `huaweicloud_voucher_status` | Check voucher status |
| `huaweicloud_voucher_claim` | Claim voucher (one per user) |
| `huaweicloud_invoke` | Execute cloud operations |

### Typical Flow

```
1. huaweicloud_auth(ak, sk, region)   → authenticate + pre-warm sandbox
2. huaweicloud_invoke(intent, token)  → query/manage resources
```

## Architecture

```
opencode (local) ──MCP──▶ hc-devkit (CCE) ──K8s──▶ Sandbox Pod ──▶ Huawei Cloud API
       │                        │
       │                 ┌──────┴──────┐
       │              Redis(DCS)   MySQL(RDS)
       │              Auth/JWT       Vouchers
       │
       └── npm hc-devkit (local MCP stdio proxy)
```

| Component | Description |
|-----------|-------------|
| **Server** | Express 5 MCP + A2A server, deployed on CCE LoadBalancer |
| **Sandbox Pod** | Ephemeral K8s Job with opencode + KooCLI + Skills |
| **Redis (DCS)** | Auth state, Job cache |
| **MySQL (RDS)** | Voucher records |

## Repository Structure

```
├── scripts/            # Local MCP stdio proxy (hc-devkit CLI)
├── cloud-server/       # Cloud A2A server
│   ├── src/            # Source code (routes, middleware, services)
│   ├── docker/         # Dockerfiles + entrypoint
│   ├── k8s/            # Deployment manifests
│   └── terraform/      # Infrastructure as code
├── packages/           # Sub-packages
│   └── huaweicloud-mate/  # MCP tool router (TypeScript)
├── skills/             # Git submodule: huaweicloud-skills
└── docs/               # Documentation
```

## Development

```bash
git clone git@github.com:huaweicloud-mate/huaweicloud-mate.git
cd huaweicloud-mate
npm install
npm run dev     # Start dev server
npm test        # Run tests
```

### Build & Deploy

```bash
# Sandbox image (requires x86_64)
docker build -t sandbox:$TAG -f cloud-server/docker/Dockerfile.sandbox .

# Server image
docker build -t server:$TAG -f cloud-server/docker/Dockerfile.server .

# Push & deploy
docker push ... && kubectl -n huaweicloud-agent set image ...
```

## License

[Apache License 2.0](LICENSE)

## Contact

- Email: HuaweiCloudDeveloper@huawei.com
- GitHub: [HuaweiCloud](https://github.com/HuaweiCloud)
- GitCode: [huaweicloud](https://gitcode.com/huaweicloud)
