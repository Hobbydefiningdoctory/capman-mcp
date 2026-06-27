# capman-mcp Roadmap

> **Audience:** Engineering team

> **Scope:** The full journey from adapter scaffolding to a production MCP server

> **Last updated:** June 2026

---

## Core Architectural Principle

**capman is an external library. capman-mcp never modifies it.**

Users install `capman` independently. `capman-mcp` depends on it as a peer dependency
(`"capman": ">=0.6.3"`) and re-exports the full capman API. Any new types or behaviour
needed by the MCP adapter are defined entirely inside `capman-mcp` — never patched into
capman itself. This keeps users on any existing capman version safe and unaffected.

```
capman  (external, published, unmodified)
  └── capman-mcp depends on it as peerDependency
        re-exports all capman API
        adds outputSchema types, Zod validation, MCP bridge on top
```

---

## What Already Exists in capman (do not re-implement)

The following are fully implemented in the current `capman` library. capman-mcp inherits
them for free via the re-export.

| Item | Where it lives | Notes |
|---|---|---|
| Capability IDs | `types.ts:Capability.id` | Required, Zod-enforced snake_case |
| Schema versioning | `types.ts:Manifest.schemaVersion` | String field |
| Semantic lifecycle | `types.ts:LifecycleInfo` | `stable \| beta \| experimental \| deprecated` |
| Input validation | `schema.ts:CapabilityParamSchema` | Full Zod: type, enum, pattern, required |
| Error registry | `types.ts:CapabilityError[]` | Per-capability, httpStatus, retryable |
| Privacy enforcement | `resolver.ts:checkPrivacy()` | `public / user_owned / admin` pre-execution |
| Zod config + manifest validation | `schema.ts` | Two schemas: config (loose) and manifest (strict) |
| Tags and filtering | `types.ts:Capability.tags` | Full filtering via `filterByTags()` |
| OpenAPI parser | `parser.ts:parseOpenAPI()` | Derives capabilities from OAS3 / Swagger 2.x specs |
| Concurrent engine | `concurrent.ts:ConcurrentCapmanEngine` | FIFO promise queue, correct for MCP server use |
| Output result typing | `engine.ts:EngineResult` | `verdict`, `trace`, `missingParams`, `resolution.data` |

---

## What capman Does Not Have (capman-mcp fills these gaps)

**1. No per-capability output schema on `Capability`**
`Capability.returns` is `string[]` — human-readable names like `["order_id", "status"]`.
It carries zero machine-readable contract. MCP tool definitions require a formal
`outputSchema` (JSON Schema object). capman-mcp defines these types locally and derives
the schema from OpenAPI specs at MCP server startup, without touching capman.

**2. No MCP transport layer**
capman has no concept of MCP tools, `tools/list`, or `tools/call`. The entire MCP
protocol bridge lives in capman-mcp.

**3. No allowlist / policy config**
capman exposes all capabilities. capman-mcp adds the operator-controlled allowlist that
governs which capabilities are surfaced as MCP tools.

**4. No invocation audit log**
capman's learning store records match feedback, not invocation audit events. capman-mcp
adds an append-only invocation logger.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    MCP Client                        │
│         (Claude Desktop / Claude API / agent)        │
└──────────────────────────┬───────────────────────────┘
                           │ MCP Protocol (stdio or HTTP/SSE)
                           ▼
┌──────────────────────────────────────────────────────┐
│                  capman-mcp                          │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │  MCP Transport  │    │   Allowlist / Policy     │ │
│  │  (stdio | HTTP) │    │   (config-driven)        │ │
│  └────────┬────────┘    └────────────┬─────────────┘ │
│           │                          │               │
│  ┌────────▼──────────────────────────▼─────────────┐ │
│  │              CapabilityToolBridge                │ │
│  │  Capability → MCP Tool  |  MCP Call → ask()     │ │
│  │  Input schema derivation | Output contract check │ │
│  │  Lifecycle filter        | Verdict propagation   │ │
│  │  Privacy gate            | missingParams → error │ │
│  └────────────────────────────────────────────────┬┘ │
│                                                   │  │
│  ┌────────────────────────────────────────────────▼┐ │
│  │            InvocationLogger                     │ │
│  │  capability_id | timestamp | params (redacted)  │ │
│  │  verdict | duration | error                     │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────┘
                           │ capman library API (unmodified)
                           ▼
┌──────────────────────────────────────────────────────┐
│                    capman (library)                  │
│          ConcurrentCapmanEngine.ask()                │
│   BM25 → Fuzzy → LLM | Cache | Learning | Privacy   │
└──────────────────────────────────────────────────────┘
```

### Key architectural decisions

**Use `ConcurrentCapmanEngine`, not `CapmanEngine`**
The MCP server is a long-lived process handling concurrent tool calls. The concurrency
model in `concurrent.ts` (FIFO promise queue) is exactly right here. Per-request engine
construction loses cache and learning state between calls.

**`stdio` transport first**
The `@modelcontextprotocol/sdk` stdio transport is the simplest path to a working demo
with Claude Desktop. HTTP/SSE is an additive layer, not a replacement — both can coexist.

**Allowlist must be structured, not a bare string array**
A bare `allowedCapabilities: string[]` cannot express per-capability policy. Use a typed
config object from day one so Phase 2 governance can extend it without breaking changes.

```typescript
interface CapmanMcpConfig {
  manifest:            string
  baseUrl?:            string
  mode?:               'cheap' | 'balanced' | 'accurate'
  dryRun?:             boolean
  transport?:          'stdio' | 'http'
  httpPort?:           number
  allowedCapabilities: AllowedCapabilityEntry[]
  audit?: {
    enabled:  boolean
    logFile?: string
  }
}

interface AllowedCapabilityEntry {
  id:                   string
  descriptionOverride?: string
  dryRunOverride?:      boolean
}
```

**Expose only `public` capabilities by default, never `deprecated` ones**
`user_owned` and `admin` require auth context MCP clients cannot reliably provide in
Phase 1. Filter to `privacy.level === 'public'` unless the operator explicitly configures
auth injection. Capabilities with `lifecycle.status === 'deprecated'` are never exposed.

**`dryRun` mode is mandatory for demos**
`dryRun: true` in `ResolveOptions` returns the planned API call without executing it.
This must be a first-class config option, not a hack.

---

## Phase 0 — Bootstrap capman-mcp Package

**Goal:** Create the `capman-mcp` package from scratch and establish the types and
validation layer that all subsequent phases depend on. Nothing in capman is touched.

**Owner:** capman-mcp
**Status:** Not started
**Depends on:** Nothing — this is the starting point

### 0-A: Package scaffold

Create `capman-mcp/` as a standalone package with a dual CJS + ESM build.

- `package.json`
  - `name: "capman-mcp"`
  - `"capman": ">=0.6.3"` as `peerDependency`
  - `"capman": "0.6.3"` as `devDependency` for local development
  - Separate `main` (CJS) and `module` / `exports` (ESM) fields
- `tsconfig.json` — CJS build targeting `dist/cjs/`
- `tsconfig.esm.json` — ESM build targeting `dist/esm/`
- Both configs resolve capman via `node_modules/capman/dist` (built output), never via
  TypeScript source paths — using `paths` to point at capman's `.ts` source breaks
  `rootDir` and must be avoided

### 0-B: `src/types.ts` — MCP-side type extensions

Define the output contract types that capman does not have. These live entirely in
capman-mcp and are never added to capman.

```typescript
// JSON Schema primitive union
export type CapabilityOutputPropertyType =
  'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'

// Recursive property descriptor
export interface CapabilityOutputProperty {
  type:         CapabilityOutputPropertyType
  description?: string
  format?:      string        // 'date-time' | 'email' | 'uri' | ...
  items?:       CapabilityOutputProperty   // for type === 'array'
  properties?:  Record<string, CapabilityOutputProperty>  // for type === 'object'
  required?:    string[]
  enum?:        (string | number | boolean)[]
}

// Top-level output schema (always type: 'object')
export interface CapabilityOutputSchema {
  type:         'object'
  properties:   Record<string, CapabilityOutputProperty>
  required?:    string[]
  description?: string
}

// MCP-side view of a capability — augments capman's Capability without modifying it
export type CapabilityWithOutput = Capability & {
  outputSchema?: CapabilityOutputSchema
}
```

Also re-export the complete capman public API so consumers only need one import:
`Capability`, `Manifest`, `EngineResult`, `ConcurrentCapmanEngine`, and all other
capman exports.

### 0-C: `src/schema.ts` — Zod validation for outputSchema

Provide runtime validation of `CapabilityOutputSchema` values. Zod v3 throughout.

- `CapabilityOutputPropertySchema` — recursive Zod schema using `z.lazy()` with an
  explicit `ZodType<CapabilityOutputProperty>` annotation (required to avoid circular
  inference errors in Zod v3)
- `CapabilityOutputSchemaZod` — top-level validator; enforces `type: 'object'` and
  at least one entry in `properties`
- `validateOutputSchema(schema: unknown): OutputSchemaValidationResult` — returns
  `{ valid: true }` or `{ valid: false, errors: string[] }` with human-readable messages;
  no Zod import required for callers

### 0-D: `src/index.ts` — single package entry point

Re-export everything so consumers have one import path:
- Full capman public API (re-exported wholesale)
- `CapabilityOutputPropertyType`, `CapabilityOutputProperty`, `CapabilityOutputSchema`,
  `CapabilityWithOutput`
- `CapabilityOutputSchemaZod`, `validateOutputSchema`, `OutputSchemaValidationResult`

### Acceptance criteria for Phase 0

- `pnpm run build` succeeds for both CJS and ESM targets
- `import { ConcurrentCapmanEngine } from 'capman-mcp'` resolves correctly (re-export works)
- `import { validateOutputSchema } from 'capman-mcp'` resolves correctly
- capman source is unmodified; `pnpm test` inside `capman/` still passes with 150 tests

---

## Phase 1 — Thin MCP Adapter

**Goal:** Ship a working, demoable MCP server that exposes an approved subset of
capabilities as MCP tools.

**Owner:** capman-mcp
**Status:** Not started
**Depends on:** Package scaffold

### Target file structure

```
capman-mcp/
  package.json           
  tsconfig.json          
  tsconfig.esm.json      
  bin/
    capman-mcp.js        ← CLI entry: capman-mcp start --config ./capman-mcp.config.js
  src/
    index.ts             
    types.ts            
    schema.ts            
    server.ts            
    bridge.ts            ← CapabilityToolBridge (Capability → MCP Tool translation)
    allowlist.ts         ← config loading, allowlist filtering, validation
    schema-derive.ts     ← CapabilityParam[] → MCP tool inputSchema derivation
    output-validate.ts   ← CapabilityWithOutput outputSchema validation on EngineResult
    logger.ts            ← InvocationLogger (append-only, redacts param values)
  tests/
    bridge.test.ts
    schema-derive.test.ts
    output-validate.test.ts
    allowlist.test.ts
    server.integration.test.ts   ← end-to-end via MCP SDK in-process transport
```

### 1-A: `bridge.ts` — CapabilityToolBridge

Core translation layer. Runs at startup and on every `tools/list` MCP request.

```typescript
function capabilityToTool(
  cap:   CapabilityWithOutput,
  entry: AllowedCapabilityEntry
): Tool {
  return {
    name:         cap.id,
    description:  entry.descriptionOverride ?? cap.description,
    inputSchema:  deriveInputSchema(cap.params),   // see 1-B
    outputSchema: cap.outputSchema                 // undefined when absent — graceful degradation
      ? deriveOutputSchema(cap.outputSchema)
      : undefined,
  }
}

function buildToolList(
  manifest: Manifest,
  config:   CapmanMcpConfig
): Tool[] {
  const allowedIds = new Set(config.allowedCapabilities.map(e => e.id))
  return manifest.capabilities
    .filter(cap => allowedIds.has(cap.id))
    .filter(cap => cap.privacy.level === 'public')
    .filter(cap => cap.lifecycle?.status !== 'deprecated')
    .map(cap => capabilityToTool(
      cap as CapabilityWithOutput,
      config.allowedCapabilities.find(e => e.id === cap.id)!
    ))
}
```

### 1-B: `schema-derive.ts` — Input Schema Derivation

Derives a JSON Schema `inputSchema` from `CapabilityParam[]`.

```
CapabilityParam.type === 'string'   → { type: 'string' }
CapabilityParam.type === 'number'   → { type: 'number' }
CapabilityParam.type === 'boolean'  → { type: 'boolean' }
CapabilityParam.type === 'email'    → { type: 'string', format: 'email' }
CapabilityParam.type === 'url'      → { type: 'string', format: 'uri' }
CapabilityParam.type === 'date'     → { type: 'string', format: 'date' }
CapabilityParam.type === 'enum'     → { type: 'string', enum: param.enum }
CapabilityParam.type === 'object'   → { type: 'object' }
param.example                       → examples: [param.example]
```

Only params with `source === 'user_query'` become MCP tool input properties. Params with
`source === 'session'` are injected from auth context and **must never appear in the MCP
input schema** — leaking them would allow callers to supply a userId and impersonate
another user.

### 1-C: `server.ts` — MCP Server Bootstrap

```typescript
async function startServer(configPath: string): Promise<void> {
  const config   = await loadConfig(configPath)
  const manifest = await readManifest(config.manifest)
  const tools    = buildToolList(manifest, config)

  validateAllowlist(config.allowedCapabilities, manifest, tools)

  const engine = new ConcurrentCapmanEngine({
    manifest,
    baseUrl:  config.baseUrl,
    mode:     config.mode ?? 'balanced',
    cache:    new MemoryCache(),          // long-lived process — memory cache is correct
    learning: new MemoryLearningStore(),
  })

  const server = new McpServer({ name: 'capman-mcp', version: pkg.version })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema,  async req => callTool(req, engine, config))

  if (config.transport === 'http') {
    await startHttpTransport(server, config.httpPort ?? 3000)
  } else {
    await startStdioTransport(server)  // default
  }
}
```

### 1-D: Tool call handler — verdict, missingParams, dryRun

The `callTool` handler is the most critical path. It must:

1. Reject calls to capabilities not in the approved tool list (defence-in-depth)
2. Pass `dryRun: true` to `engine.ask()` when configured
3. Return structured MCP errors for `missingParams` — not silent nulls
4. Annotate the response with `verdict` when it is `marginal` or `uncertain`
5. Validate the response against `outputSchema` if present — log a warning on mismatch
   but do not throw; the live API result is authoritative over the declared schema

```typescript
async function callTool(
  req:    CallToolRequest,
  engine: ConcurrentCapmanEngine,
  config: CapmanMcpConfig,
): Promise<CallToolResult> {
  const entry = config.allowedCapabilities.find(e => e.id === req.params.name)
  if (!entry) {
    return { isError: true, content: [{ type: 'text', text: `Tool "${req.params.name}" is not approved` }] }
  }

  const query = buildQueryFromArgs(req.params.name, req.params.arguments ?? {})

  const result = await engine.ask(query, {
    dryRun: entry.dryRunOverride ?? config.dryRun ?? false,
  })

  logger.logInvocation({
    capabilityId: req.params.name,
    verdict:      result.verdict,
    durationMs:   result.durationMs,
    error:        result.resolution.error,
  })

  if (result.missingParams?.length) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Missing required parameters: ${result.missingParams.join(', ')}`,
      }],
    }
  }

  if (!result.resolution.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.resolution.error ?? 'Resolution failed' }],
    }
  }

  return { content: buildMcpContent(result) }
}
```

### 1-E: `schema-derive.ts` — outputSchema derivation from OpenAPI specs

capman's `parseOpenAPI()` returns `Capability[]`. The returned capabilities have no
`outputSchema` field (capman is unmodified). capman-mcp derives `outputSchema` separately
at MCP server startup by re-reading the same OpenAPI spec and building
`CapabilityWithOutput[]`.

```typescript
// At MCP server startup — capman is not involved in this derivation
async function enrichWithOutputSchemas(
  caps:    Capability[],
  specPath: string,
): Promise<CapabilityWithOutput[]> {
  const spec = await loadSpec(specPath)
  const allSchemas = spec.components?.schemas ?? spec.definitions ?? {}
  return caps.map(cap => ({
    ...cap,
    outputSchema: deriveOutputSchemaForCapability(cap, spec, allSchemas),
  }))
}
```

The derivation logic (`resolveRef`, `mergeAllOf`, `convertToOutputProperty`, depth-3 cap)
lives entirely inside `schema-derive.ts`. capman is not involved.

### 1-F: Query builder — structured args → natural language query

MCP clients send structured JSON arguments. `engine.ask()` expects a natural language
query string. Phase 1 uses a deterministic serialiser:

```
{ tool: "get_order", args: { order_id: "ORD-123" } }
  →  "get_order order_id ORD-123"
```

The BM25 matcher matches `get_order` against the capability ID/name with near-100%
confidence; `extractParams()` picks up the value. Phase 2 will add `resolveById(id,
params)` to bypass the matcher entirely for structured calls.

### 1-G: `logger.ts` — InvocationLogger

Append-only audit log. Logs to stderr by default, optional file path in config. Never
logs param **values** — only param names.

```jsonc
{
  "ts":           "2026-06-12T13:00:00.000Z",
  "capabilityId": "get_order",
  "verdict":      "clear",
  "resolvedVia":  "keyword",
  "durationMs":   42,
  "dryRun":       false,
  "params":       ["order_id"],
  "error":        null
}
```

### 1-H: Demo mode

A `capman-mcp demo` CLI command that:

1. Loads a bundled demo manifest
2. Starts the MCP server with `dryRun: true`
3. Prints Claude Desktop connection instructions
4. Outputs invocation logs in human-readable format

---

## Phase 2 — Registry and Ownership

**Goal:** Replace the local config/allowlist with a queryable capability registry.

**Depends on:** Phase 1 complete and stable

### Registry data model

```typescript
interface RegistryEntry {
  fullyQualifiedId: string           // "{app_slug}/{capability_id}"
  schemaVersion:    string
  owner:            string
  status:           LifecycleStatus
  schemaHash:       string           // SHA-256 of the Zod-serialized definition
  approvedForMcp:   boolean
  publishedAt:      string
  deprecatedAt?:    string
  successor?:       string
}
```

### Registry CLI

```bash
capman-mcp registry publish    # register/update capability from manifest
capman-mcp registry deprecate  # mark deprecated, optionally specify successor
capman-mcp registry list       # list capabilities with status
capman-mcp registry diff       # compare two schema versions
```

### MCP adapter change

`buildToolList()` queries the registry instead of reading a static allowlist. The
`AllowedCapabilityEntry.id` config remains as an override layer.

Also in Phase 2: add `resolveById(id, params)` to capman-mcp's engine wrapper to bypass
the BM25 matcher for structured MCP calls (the caller already named the tool explicitly).

---

## Phase 3 — Policy and Risk

**Goal:** Add structured governance so high-risk capabilities require approval and are
gated from MCP by default.

**Depends on:** Phase 2 complete

### Risk levels

```
low     — read-only, public data. Auto-approved for MCP.
medium  — reads user-owned data or non-destructive writes. Requires manual approval.
high    — writes, deletions, financial ops. Gated by default; requires explicit override.
```

Derived automatically from HTTP method + privacy level:
- `GET` + `public` → `low`
- Any method + `user_owned` → `medium`
- `POST/PUT/PATCH/DELETE` + any privacy → at least `medium`
- `admin` or financial `CapabilityError` code → `high`

---

## Phase 4 — Dependency Graph and Catalog

**Goal:** Make capabilities discoverable and understand their relationships.

**Depends on:** Phase 3 complete

- `dependsOn?: string[]` on `RegistryEntry` — explicit dependency declarations
- Cycle detection on every `publish`
- `capman-mcp registry impact <id>` — shows affected capabilities
- Read-only catalog HTTP service with full-text search, filters, MCP compatibility badge

---

## Phase 5 — Production Control Plane

**Goal:** Operate capman-mcp at scale across multiple teams and environments.

**Depends on:** Phase 4 complete

| Service | Responsibility |
|---|---|
| Registry API | Persistent capability store, version history, approval workflow |
| Policy Engine | Real-time approval evaluation, risk scoring |
| Telemetry Collector | Aggregates invocation logs from all MCP instances |
| Cache Coordinator | Redis-backed shared cache replacing per-instance MemoryCache |
| Health Dashboard | Circuit breaker status, LLM quota, invocation rates |

---

## Sprint Plan

### Sprint 1 — Phase 0: Bootstrap capman-mcp package

1. Create `capman-mcp/package.json` — peerDep capman >=0.6.3,devDep file:../capman, dual CJS + ESM build scripts
2. Create `tsconfig.json` (CJS → `dist/cjs/`) and `tsconfig.esm.json` (ESM → `dist/esm/`) — resolve capman via node_modules, never via TS source paths
3. Implement `src/types.ts` — `CapabilityOutputPropertyType`, `CapabilityOutputProperty`, `CapabilityOutputSchema`, `CapabilityWithOutput`; re-export all capman types
4. Implement `src/schema.ts` — `CapabilityOutputPropertySchema` (recursive z.lazy()), `CapabilityOutputSchemaZod`, `validateOutputSchema()`
5. Implement `src/index.ts` — single entry point re-exporting capman API + local extensions
6. Verify `pnpm run build` passes for both targets; verify capman tests (150) still pass unmodified

### Sprint 2 — MCP adapter core (Phase 1)

1. Install `@modelcontextprotocol/sdk` in capman-mcp
2. Implement `src/allowlist.ts` — config loading, validation
3. Implement `src/schema-derive.ts` — `CapabilityParam[]` → inputSchema, outputSchema derivation from OpenAPI spec
4. Implement `src/bridge.ts` — `CapabilityToolBridge` (Capability → MCP Tool)
5. Implement `src/server.ts` — stdio transport, `tools/list` handler
6. Implement `callTool` handler — verdict, missingParams, dryRun (1-D)
7. Implement `src/logger.ts` — InvocationLogger
8. Write unit tests for `bridge.test.ts` and `schema-derive.test.ts`

### Sprint 3 — Demo-ready (Phase 1 completion)

9. Implement query builder (1-F) — structured args → query string
10. Implement `src/output-validate.ts` — outputSchema validation on EngineResult
11. Implement `capman-mcp demo` CLI command (1-H)
12. Write integration test via MCP SDK in-process transport
13. Add HTTP/SSE transport behind a feature flag
14. Write `README.md` with Claude Desktop setup instructions

### Sprint 4 — Registry foundation (Phase 2 start)

15. Design and implement registry data model + SQLite store
16. Implement `capman-mcp registry publish / list / deprecate` CLI
17. Switch `buildToolList()` to query registry
18. Add `resolveById()` wrapper in capman-mcp to bypass matcher for structured calls

---

## Deferred (capman library — not in scope for capman-mcp)

These are improvements to the `capman` library that would benefit capman-mcp but are
**not prerequisites** and are out of scope until the capman team decides to ship them.
capman-mcp works correctly today without any of these.

| Item | Description | Benefit to capman-mcp |
|---|---|---|
| Engine split (0-A) | Decompose `engine.ts` monolith into focused modules | Easier to import internal engine state for health dashboard |
| semver `schemaVersion` (0-C) | Emit `"1.0.0"` instead of `"1"`, range-match on load | Cleaner version negotiation in Phase 2 registry |
| Namespace convention (0-D) | Document `{app_slug}/{capability_id}` format | Used by Phase 2 registry for fully-qualified IDs |
| Compat test suite (0-E) | `tests/compat/` with golden-output tests | Regression baseline before engine refactor |
| Native `outputSchema` on `Capability` | Add field directly to capman's `Capability` type | capman-mcp can drop its `CapabilityWithOutput` augmentation |

---

## Open Questions

| Question | Why it matters |
|---|---|
| How does capman-mcp handle `user_owned` capabilities? | Determines whether auth injection config is needed in Phase 1 |
| What is the correct behaviour when `verdict === 'uncertain'`? | The MCP client can't retry without this contract |
| Should `capman-mcp demo` use a bundled manifest or require the user's own? | Affects cold-start UX for new evaluators |
| Will capman-mcp be published to npm separately or only alongside capman? | Affects versioning strategy |
| Which MCP protocol version does the target Claude Desktop support? | Determines SDK version and available schema features |
