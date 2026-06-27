# capman-mcp

> MCP (Model Context Protocol) adapter for [capman](https://github.com/your-org/capman) —
> exposes a capman capability manifest as a typed, governed set of MCP tools callable by
> Claude Desktop, the Claude API, or any MCP-compatible client.

**Version:** 0.1.0 · **Node.js:** ≥ 18 · **capman peer:** ≥ 0.6.3 · **License:** MIT

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [Quick start — Claude Desktop](#quick-start--claude-desktop)
5. [Demo mode](#demo-mode)
6. [Operating modes](#operating-modes)
7. [Config reference](#config-reference)
8. [Capability filtering](#capability-filtering)
9. [Policy gate and risk levels](#policy-gate-and-risk-levels)
10. [Registry](#registry)
11. [Dependency graph](#dependency-graph)
12. [Catalog service](#catalog-service)
13. [Matching modes](#matching-modes)
14. [Verdict handling](#verdict-handling)
15. [Audit log](#audit-log)
16. [HTTP transport](#http-transport)
17. [Troubleshooting](#troubleshooting)

---

## Overview

capman-mcp sits between your capman manifest and any MCP client. It reads your manifest,
applies a governance layer (approval, privacy, risk), and exposes each approved capability
as a typed MCP tool. Every tool call is translated into `engine.ask()`, the result is
validated, logged, and returned as a structured MCP response.

```
MCP client (Claude Desktop / API)
         │  tools/list + tools/call (MCP protocol)
         ▼
    capman-mcp
    ├── Approval gate    (allowlist or registry)
    ├── Privacy filter   (public only)
    ├── Risk gate        (policyGate — blocks high-risk by default)
    ├── Dependency graph (cycle detection + impact analysis)
    └── Catalog service  (read-only HTTP discovery API)
         │  engine.ask()
         ▼
       capman  (BM25 → LLM → resolve → HTTP)
         │
         ▼
    Your app's REST API
```

---

## Architecture

capman-mcp is composed of six independent layers, each in its own module:

| Module | Responsibility |
|---|---|
| `bridge.ts` | Converts manifest capabilities to MCP tool definitions; applies all filters |
| `allowlist.ts` | Loads config; validates allowed capability IDs |
| `server.ts` | MCP server bootstrap; `callTool` handler; demo mode |
| `logger.ts` | Append-only audit log; JSON (production) or human-readable (demo) |
| `registry.ts` | Persistent capability registry; publish, deprecate, diff |
| `risk.ts` | Pure risk level derivation from HTTP method, privacy, and error codes |
| `graph.ts` | Dependency graph; cycle detection; impact analysis |
| `catalog.ts` | Read-only HTTP catalog service |
| `resolve.ts` | `resolveById` — registry-mode bypass of the matcher |
| `schema-derive.ts` | Input/output schema derivation from capability definitions |
| `output-validate.ts` | Runtime validation of engine results against declared output schemas |

---

## Installation

```bash
npm install capman-mcp capman
```

capman is a peer dependency. Install it alongside capman-mcp so you control the version.

---

## Quick start — Claude Desktop

### 1. Generate your manifest

```bash
# From an existing OpenAPI spec
npx capman generate --from openapi.json

# Or from a capman.config.js you wrote
npx capman generate
```

This produces `capman.manifest.json` in your working directory.

### 2. Create `capman-mcp.config.js`

```js
// capman-mcp.config.js
module.exports = {
  manifest: '/absolute/path/to/capman.manifest.json',
  baseUrl:  'https://api.your-app.com',
  mode:     'balanced',
  dryRun:   false,
  transport: 'stdio',

  allowedCapabilities: [
    { id: 'get_order' },
    { id: 'list_products' },
    { id: 'check_availability' },
  ],

  audit: {
    enabled: true,
    logFile: '.capman/mcp-audit.log',
  },
}
```

> **Always use absolute paths.** Claude Desktop resolves paths from its own working
> directory, not yours. Relative paths will silently fail to load.

### 3. Add capman-mcp to Claude Desktop

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add a new entry under `mcpServers`:

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": [
        "capman-mcp",
        "start",
        "--config",
        "/absolute/path/to/capman-mcp.config.js"
      ]
    }
  }
}
```

### 4. Test before connecting

Run the server manually first to confirm the config loads cleanly:

```bash
npx capman-mcp start --config /absolute/path/to/capman-mcp.config.js
```

Expected output:

```
[capman-mcp] Loaded manifest: your-app (12 capabilities)
[capman-mcp] 8 tools registered
[capman-mcp] MCP server running on stdio
```

### 5. Restart Claude Desktop

Quit Claude Desktop completely and reopen it. Your capabilities are now available as tools.

---

## Demo mode

Try capman-mcp with a bundled sample manifest — no real app, no config, no API keys:

```bash
npx capman-mcp demo
```

This starts a `dryRun: true` server with 4 sample e-commerce capabilities. To connect
Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "capman-demo": {
      "command": "npx",
      "args": ["capman-mcp", "demo"]
    }
  }
}
```

Then restart Claude Desktop and ask: `"get order ORD-123"` or `"list products"`.

---

## Operating modes

capman-mcp supports two approval modes. Choose one per deployment.

### Config mode (default)

The `allowedCapabilities` array in your config file is the source of truth for which
capabilities are exposed. Straightforward for single-service or single-team setups.

```js
allowedCapabilities: [
  { id: 'get_order' },
  { id: 'list_products', descriptionOverride: 'Browse the product catalog' },
  { id: 'delete_account', allowHighRisk: true },
]
```

### Registry mode

Set `registryPath` to enable registry-based approval. Approval state, risk level,
dependency declarations, and deprecation are all stored in a versioned JSON registry
file. Intended for teams where a CI pipeline publishes capabilities and a separate
approval step gates MCP exposure.

```js
module.exports = {
  manifest:      '/path/to/capman.manifest.json',
  registryPath:  '/path/to/.capman-mcp/registry.json',
  transport:     'stdio',
  // allowedCapabilities can still be used for descriptionOverride / dryRunOverride
  allowedCapabilities: [],
}
```

In registry mode, `resolveById` is used instead of `engine.ask()` — the tool name
directly identifies the capability, bypassing the matcher entirely for lower latency.

---

## Config reference

### `CapmanMcpConfig`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `manifest` | `string` | ✅ | — | Absolute path to `capman.manifest.json` |
| `baseUrl` | `string` | — | — | Base URL for API resolvers |
| `mode` | `'cheap' \| 'balanced' \| 'accurate'` | — | `'balanced'` | Matching mode (config mode only) |
| `dryRun` | `boolean` | — | `false` | Plan API calls without executing them |
| `transport` | `'stdio' \| 'http'` | — | `'stdio'` | MCP transport |
| `httpPort` | `number` | — | `3000` | Port when `transport: 'http'` |
| `allowedCapabilities` | `AllowedCapabilityEntry[]` | ✅* | — | *Required in config mode; optional override layer in registry mode |
| `registryPath` | `string` | — | — | Enables registry mode when set |
| `policyGate` | `boolean` | — | `true` | Block high-risk capabilities unless explicitly opted in |
| `auth` | `CapmanMcpAuthConfig` | — | — | Auth context for the server instance. Required to expose `user_owned` capabilities |
| `audit.enabled` | `boolean` | — | `true` | Enable invocation logging |
| `audit.logFile` | `string` | — | stderr | Append-only audit log path |

### `AllowedCapabilityEntry`

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Capability ID from your manifest |
| `descriptionOverride` | `string` | — | Replaces the capability description shown in the MCP tool listing |
| `dryRunOverride` | `boolean` | — | Per-capability dry-run — takes precedence over global `dryRun` |
| `allowHighRisk` | `boolean` | — | Explicitly expose this capability despite a `high` risk level |

### `CapmanMcpAuthConfig`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `isAuthenticated` | `boolean` | ✅ | — | Must be `true` for `user_owned` capabilities to be exposed and executed |
| `userId` | `string` | — | — | Injected by capman into params marked `source: 'session'`. Never exposed to the agent |
| `role` | `'user' \| 'admin'` | — | `'user'` | User's role. `admin` capabilities remain hard-blocked regardless of this value |

---

## Capability filtering

`buildToolList` applies four filters in order before exposing a capability as an MCP tool.
A capability must pass all four to appear.

| Filter | Condition to pass | Notes |
|---|---|---|
| 1. Approval | In `allowedCapabilities` (config mode) or `approvedForMcp: true` in registry | |
| 2. Privacy | `privacy.level === 'public'` | `user_owned` and `admin` require auth context MCP cannot provide |
| 3. Lifecycle | `lifecycle.status !== 'deprecated'` | Deprecated capabilities are never surfaced |
| 4. Risk gate | `riskLevel !== 'high'` OR `allowHighRisk: true` OR `riskOverride: 'allow'` | Controlled by `policyGate` — see below |

---

## Exposing user_owned capabilities

By default capman-mcp only exposes `public` capabilities — those that require no
authentication. Many real-world agent workflows need to act on behalf of a specific
user: retrieving their orders, updating their account settings, or fetching personalised
data. These capabilities have `privacy.level === 'user_owned'` in the capman manifest.

To expose them, add an `auth` block to your config:

```js
module.exports = {
  manifest: '/path/to/capman.manifest.json',
  baseUrl:  'https://api.your-app.com',
  transport: 'stdio',

  auth: {
    isAuthenticated: true,
    userId: 'usr-alice-123',  // the user this server instance acts as
    role:   'user',
  },

  allowedCapabilities: [
    { id: 'get_my_orders' },       // user_owned — exposed because auth is set
    { id: 'get_product_catalog' }, // public — always exposed
  ],
}
```

### What `auth` does

- The privacy filter in `buildToolList` allows `user_owned` capabilities through
  alongside `public` ones.
- capman receives the `AuthContext` on every tool call and enforces `privacy.level`
  at execution time — if `isAuthenticated` is `false`, capman rejects the call.
- capman injects `auth.userId` into params marked `source: 'session'` before making
  the API call. For example, a capability defined with a `user_id` session param and
  path `/users/{user_id}/orders` will automatically call `/users/usr-alice-123/orders`.
  The agent never sees or supplies the `userId` — it is excluded from the MCP input
  schema entirely.

### Privacy levels and auth

| `privacy.level` | No `auth` | `auth.isAuthenticated: true` |
|---|---|---|
| `public` | ✅ Exposed | ✅ Exposed |
| `user_owned` | ❌ Blocked | ✅ Exposed |
| `admin` | ❌ Blocked | ❌ Blocked always |

### Limitations

This is a **static, server-level identity**. Every tool call on this server instance
runs as the same user. This is correct for:

- Personal Claude Desktop setups (one person, one server)
- Single-user API automations

It is not suitable for multi-user deployments where different callers need different
identities. Per-request identity requires transport-level auth signal support, which
will be added in a future release when the MCP protocol standardises per-request
auth headers.

---

## Policy gate and risk levels

Every capability is assigned a risk level automatically on registry publish and at
tool-list build time. The derivation rules are applied top-down, first match wins.

| Rule | Condition | Risk level |
|---|---|---|
| 1 | `privacy.level === 'admin'` | `high` |
| 2 | Any `CapabilityError.code` contains a financial keyword | `high` |
| 3 | Resolver uses `POST`, `PUT`, `PATCH`, or `DELETE` | `medium` |
| 4 | `privacy.level === 'user_owned'` | `medium` |
| 5 | `GET`/`HEAD`/`OPTIONS` + `public` privacy | `low` |

**Financial keywords** (matched case-insensitively as substrings of the error code):
`payment`, `charge`, `billing`, `financial`, `refund`, `invoice`, `subscription`.

### `policyGate`

When `policyGate` is `true` (the default), `high`-risk capabilities are blocked from
MCP exposure unless explicitly opted in.

```js
module.exports = {
  policyGate: true,   // default — safe for production
  allowedCapabilities: [
    { id: 'get_order' },                           // low risk — passes automatically
    { id: 'delete_account', allowHighRisk: true }, // high risk — opted in explicitly
  ],
}
```

Disable the gate only for fully trusted internal deployments:

```js
policyGate: false
```

### Registry mode risk overrides

In registry mode, each `RegistryEntry` carries a `riskOverride` field that takes
precedence over the computed `riskLevel`:

| `riskOverride` value | Effect |
|---|---|
| `'allow'` | Expose despite `high` risk (operator has reviewed and approved) |
| `'block'` | Never expose, regardless of risk level (hard block) |
| absent | Default gate behaviour |

```json
{
  "fullyQualifiedId": "my-app/create_payment",
  "riskLevel": "high",
  "riskOverride": "allow",
  "approvedForMcp": true
}
```

---

## Registry

The registry is a persistent JSON file that tracks every published capability with its
approval state, risk level, schema hash, and dependency declarations. It is the
source of truth in registry mode and the backing store for the catalog service.

### CLI commands

```bash
# Publish all capabilities from a manifest into the registry
capman-mcp registry publish --manifest capman.manifest.json --owner ci-bot

# Publish without approving for MCP (pending review state)
capman-mcp registry publish --manifest capman.manifest.json --no-approved-for-mcp

# List all registry entries with status, risk, and approval state
capman-mcp registry list

# Show what would change if you published a new manifest version
capman-mcp registry diff --manifest capman.manifest.json

# Deprecate a capability (with optional successor)
capman-mcp registry deprecate my-app/old_endpoint --successor my-app/new_endpoint

# Show all capabilities that depend on a given capability
capman-mcp registry impact my-app/get_order

# All commands accept --registry <path> to target a non-default registry file
```

### `registry list` output

```
ID                                    STATUS    RISK     APPROVED  OWNER
my-app/get_order                      stable    low      true      ci-bot
my-app/create_payment                 stable    high     false     ci-bot
my-app/old_search                     deprecated medium  true      ci-bot
```

### `registry diff` output

```
  ~ [changed] [low]    my-app/get_order
  + [new]     [medium] my-app/create_refund
  - [removed]          my-app/legacy_checkout
    [unchanged]        my-app/list_products
```

### `RegistryEntry` fields

| Field | Type | Description |
|---|---|---|
| `fullyQualifiedId` | `string` | `"{appSlug}/{capabilityId}"` |
| `schemaVersion` | `string` | Manifest schema version at publish time |
| `owner` | `string` | Team or CI identity that last published |
| `status` | `LifecycleStatus` | `stable`, `beta`, `experimental`, `deprecated` |
| `schemaHash` | `string` | SHA-256 of the capability definition |
| `approvedForMcp` | `boolean` | Whether this capability is exposed via MCP |
| `riskLevel` | `'low' \| 'medium' \| 'high'` | Auto-derived on publish |
| `riskOverride` | `'allow' \| 'block'` | Operator override (optional) |
| `dependsOn` | `string[]` | Explicit dependency declarations (optional) |
| `publishedAt` | `string` | ISO 8601 timestamp of last publish |
| `deprecatedAt` | `string` | ISO 8601 timestamp of deprecation (optional) |
| `successor` | `string` | `fullyQualifiedId` of the replacement (optional) |

---

## Dependency graph

### Declaring dependencies

Set `dependsOn` on a registry entry to declare that one capability relies on another.
Values are `fullyQualifiedId` strings:

```json
{
  "fullyQualifiedId": "my-shop/order_summary",
  "dependsOn": ["my-shop/get_order", "my-shop/get_customer"]
}
```

### Cycle detection

Cycle detection runs automatically on every `registry publish`. If a publish would
introduce a circular dependency chain, it is rejected before the registry file is
written — the operation is atomic.

```
Error: Circular dependency detected: my-shop/a → my-shop/b → my-shop/c → my-shop/a
Fix: remove one of the dependsOn declarations that forms this cycle.
```

### Impact analysis

Find all capabilities that would be affected if a given capability changes:

```bash
capman-mcp registry impact my-shop/get_order
```

```
Impact analysis for: my-shop/get_order
2 capabilities would be affected if this changes:

  my-shop/order_summary   (stable, medium)
  my-shop/checkout_flow   (stable, low)
```

This performs a reverse-graph BFS — it finds every capability that directly or
transitively depends on the given one, not just its immediate consumers.

---

## Catalog service

The catalog is a read-only HTTP service that makes your capability registry discoverable.
Start it alongside your MCP server or as a standalone process:

```bash
capman-mcp catalog start --port 4001 --manifest capman.manifest.json
```

```
[capman-mcp] Catalog server running at http://localhost:4001
[capman-mcp] Endpoints:
[capman-mcp]   GET /health
[capman-mcp]   GET /capabilities
[capman-mcp]   GET /capabilities/:fqId
[capman-mcp]   GET /capabilities/:fqId/badge
[capman-mcp]   GET /capabilities/:fqId/impact
```

The catalog reloads the registry on every request — it always reflects the current state
without a restart.

### Endpoints

| Endpoint | Response |
|---|---|
| `GET /health` | `{ ok: true, count: N }` |
| `GET /capabilities` | `RegistryEntry[]` — supports filters |
| `GET /capabilities/:fqId` | Single `RegistryEntry` or 404 |
| `GET /capabilities/:fqId/badge` | SVG compatibility badge |
| `GET /capabilities/:fqId/impact` | `{ fullyQualifiedId, impacted: string[] }` |

### Query filters for `GET /capabilities`

| Parameter | Example | Effect |
|---|---|---|
| `q` | `?q=order` | Case-insensitive substring match on `fullyQualifiedId` and `owner` |
| `risk` | `?risk=high` | Filter by `low`, `medium`, or `high` |
| `status` | `?status=stable` | Filter by lifecycle status |
| `approvedForMcp` | `?approvedForMcp=false` | Filter by approval state |

Parameters combine: `GET /capabilities?risk=high&approvedForMcp=true`

### Badge colours

Embed a capability's MCP compatibility badge anywhere SVG is supported:

```html
<img src="http://localhost:4001/capabilities/my-app/get_order/badge" />
```

| Colour | Meaning |
|---|---|
| 🟢 Green | `approvedForMcp: true`, risk level `low` or `medium` |
| 🟡 Amber | `approvedForMcp: true`, risk level `high` — review recommended |
| 🔴 Red | `approvedForMcp: false` or `riskOverride: 'block'` |

---

## Matching modes

capman-mcp delegates matching to capman's engine. Three modes trade API cost against
matching accuracy. The mode is set per-server in config.

| Mode | Behaviour | Best for |
|---|---|---|
| `cheap` | BM25 keyword only — zero LLM calls | Registry mode (tool name is explicit) |
| `balanced` | Keyword first; LLM fallback when confidence < 50% | Most production deployments |
| `accurate` | LLM over top-3 candidates on every call | High-ambiguity capability sets |

In registry mode, `resolveById` is used instead of `engine.ask()`, making the matching
mode irrelevant — the tool name is an exact capability ID.

---

## Verdict handling

Each `engine.ask()` call returns a `verdict` that capman-mcp surfaces in the MCP response:

| Verdict | Meaning | MCP response |
|---|---|---|
| `clear` | High-confidence match, large margin over runner-up | Returned as-is |
| `marginal` | Top two candidates are close in score | Prefixed with `[verdict: marginal]` |
| `uncertain` | Confidence below threshold | Prefixed with `[verdict: uncertain]` |

The client (Claude) sees the verdict annotation and can ask for user confirmation before
acting on a `marginal` result.

---

## Audit log

When `audit.enabled` is `true`, every tool invocation is written as one JSON line:

```json
{
  "ts": "2026-06-13T09:00:00.000Z",
  "capabilityId": "get_order",
  "verdict": "clear",
  "resolvedVia": "keyword",
  "durationMs": 42,
  "dryRun": false,
  "params": ["order_id"],
  "error": null
}
```

Param **values** are never logged — only param names. The log is append-only and safe
to tail in production. In demo mode, the log is written in human-readable format instead.

---

## HTTP transport

For integrations that cannot use stdio:

```js
module.exports = {
  transport: 'http',
  httpPort:  3000,
}
```

```bash
npx capman-mcp start --config capman-mcp.config.js
# [capman-mcp] MCP server listening on http://localhost:3000
```

---

## Troubleshooting

**Claude Desktop shows no tools after restart**

- Ensure all paths in `claude_desktop_config.json` are absolute.
- Run the start command manually in a terminal to see errors directly:
  ```bash
  npx capman-mcp start --config /absolute/path/to/capman-mcp.config.js
  ```
- Verify the manifest is valid: `npx capman validate`

**`Error: config.manifest must be a non-empty string path`**

The `manifest` field is missing from your config or is not a string.

**`allowlist entry "X" not found in manifest`**

The ID in `allowedCapabilities` does not exist in your manifest.
Run `npx capman inspect` to list all valid capability IDs.

**`allowlist entry "X" filtered out (non-public or deprecated)`**

The capability exists but has `privacy.level !== 'public'` or is deprecated.
It cannot be exposed as an MCP tool.

**Tool calls return `Missing required parameters: <name>`**

capman could not extract the parameter from the query string. In `balanced` or
`accurate` mode, capman will attempt LLM extraction automatically. In `cheap` mode,
the parameter value must appear literally in the query. Add more `examples` to the
capability definition to improve extraction.

**`Circular dependency detected: ...`**

A `registry publish` was rejected because `dependsOn` declarations form a cycle.
Remove one of the declarations named in the error path.

**`enrichWithOutputSchemas does not support YAML specs yet`**

Convert your OpenAPI spec to JSON before calling `enrichWithOutputSchemas`:

```bash
npx js-yaml your-spec.yaml > your-spec.json
```

---

## License

MIT