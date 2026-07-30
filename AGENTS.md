# AGENTS.md

## Project overview

Dual-package repo building an MCP plugin for managing Huawei Cloud resources via AI agents. Architecture: `AIClient --MCP--> hc-devkit Server (CCE) --K8s--> Sandbox Pod --Huawei Cloud API`, with Redis (DCS) for auth state and MySQL (RDS) for persistence.

## Package boundaries

| Package | Path | Type | npm name |
|---------|------|------|----------|
| `hc-devkit` (root) | `.` | ES Module | `hc-devkit` |
| `huaweicloud-mate` | `huaweicloud-mate/` | CommonJS (compiled from TS) | `huaweicloud-mate` |

- **Root** = Express 5 MCP server (`server/`) + stdio proxy (`bin/hc-devkit.js`). Deployed on CCE.
- **Nested** = TypeScript tool router compiled to CJS (`src/router/` → `dist/`). Runs inside sandbox K8s Jobs.
- **Infra** = `cloud-server/k8s/` (manifests) + `cloud-server/terraform/` (IaC).

Sources of truth: `README.md`, `server/` (JS), `huaweicloud-mate/src/router/` (TS).

## Commands

### Root (`hc-devkit`)

```bash
npm test              # vitest run (all tests in server/*.test.js)
npm start             # node server/server.js (port 3000)
npm run dev           # node --watch server/server.js
```

Run a single test:
```bash
npx vitest run server/auth.test.js       # one file
npx vitest run -t "verifySignature"       # pattern match
```

### Nested (`huaweicloud-mate`)

```bash
# Run from huaweicloud-mate/ directory
npm run build         # tsc (typecheck + compile to dist/)
npx tsc --noEmit      # typecheck only
npm run build:catalog # python3 scripts/build-capability-index.py (regenerates data/capability_index.json)
npm run prepare       # runs build on install
```

**No test command** in this package. No vitest/jest configured.

## Key constraints

- **No lint/format commands configured.** No ESLint or prettier in either package.
- **Express 5** (not v4). Breaking differences in error handling and middleware.
- **All `.catch()` blocks must log errors.** Enforced by `server/empty-catch.test.js`.
- **Redis is mandatory for auth.** No in-memory fallback; returns 503 if unavailable.
- **Multi-region keys in Redis:** use `ak:region` format, not bare AK.
- **MySQL field whitelist** for task updates: `TASK_UPDATE_WHITELIST` in `server/db.js`.
- **`capability_index.json` is 548k lines.** Auto-generated from `hcloud --help` discovery; loaded into memory at router startup.
- **Skills:** `skills/` is a git submodule (`huaweicloud-skills`). Run `git submodule update --init` if files are missing.
- **Sandbox K8s Jobs are ephemeral:** TTL 30min (users), 60s (anonymous). Redis tracks job state.
- **Docker builds require x86_64.** ARM64 hosts need the jump host `110.41.83.215`.
- **CI** publishes root `hc-devkit` to npm on `v*` tags, and mirrors to GitCode on every push.
