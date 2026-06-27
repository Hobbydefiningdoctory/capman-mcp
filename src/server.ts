import * as http from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ConcurrentCapmanEngine,
  MemoryCache,
  MemoryLearningStore,
  readManifest,
} from 'capman'
import type { EngineResult } from 'capman'
import { loadConfig, validateAllowlist } from './allowlist'
import { buildToolList } from './bridge'
import { InvocationLogger } from './logger'
import { validateEngineResultOutput } from './output-validate'
import { loadRegistry } from './registry'
import { resolveById } from './resolve'
import type { CapmanMcpConfig, CapabilityWithOutput, InvocationLogEntry } from './types'

const VERSION = '0.1.0'

/**
 * Build a natural language query string from a structured MCP tool call.
 * Used in config mode (no registryPath) where engine.ask() handles matching.
 *
 *   { tool: "get_order", args: { order_id: "ORD-123" } }
 *   → "get_order order_id ORD-123"
 *
 * The BM25 matcher in capman matches the tool name with near-100% confidence;
 * extractParams() picks up the argument values from the flattened string.
 * In registry mode, resolveById() is used instead — the matcher is bypassed.
 */
function buildQueryFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const parts: string[] = [toolName]
  for (const [k, v] of Object.entries(args)) {
    parts.push(k, String(v))
  }
  return parts.join(' ')
}

function buildMcpContent(
  result: EngineResult,
): Array<{ type: 'text'; text: string }> {
  const lines: string[] = []

  if (result.verdict !== 'clear') {
    lines.push(`[verdict: ${result.verdict}]`)
  }

  if (result.resolution.data !== undefined) {
    lines.push(
      typeof result.resolution.data === 'string'
        ? result.resolution.data
        : JSON.stringify(result.resolution.data, null, 2),
    )
  } else if (result.resolution.navTarget) {
    lines.push(`Navigate to: ${result.resolution.navTarget}`)
  }

  return [{ type: 'text', text: lines.join('\n') || 'OK' }]
}

export async function callTool(
  req: CallToolRequest,
  engine: ConcurrentCapmanEngine,
  config: CapmanMcpConfig,
  logger: InvocationLogger,
  capMap: Map<string, CapabilityWithOutput>,
): Promise<CallToolResult> {
  const args = (req.params.arguments as Record<string, unknown>) ?? {}
  const entry = config.allowedCapabilities.find(e => e.id === req.params.name)

  // Registry mode: tools were already gated by buildToolList; the config entry is
  // optional (override layer only).  Config mode: entry must be present.
  const approved = config.registryPath ? capMap.has(req.params.name) : entry !== undefined
  if (!approved) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool "${req.params.name}" is not approved` }],
    }
  }

  const dryRun = entry?.dryRunOverride ?? config.dryRun ?? false

  const startMs = Date.now()
  let result: EngineResult
  try {
    if (config.registryPath) {
      result = await resolveById(req.params.name, args, capMap, {
        baseUrl: config.baseUrl,
        dryRun,
        auth:    config.auth,
      })
    } else {
      const query = buildQueryFromArgs(req.params.name, args)
      result = await engine.ask(query, { dryRun, auth: config.auth })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const logEntry: InvocationLogEntry = {
      ts: new Date().toISOString(),
      capabilityId: req.params.name,
      verdict: 'uncertain',
      resolvedVia: 'keyword',
      durationMs: Date.now() - startMs,
      dryRun,
      params: Object.keys(args),
      error: errMsg,
    }
    logger.logInvocation(logEntry)
    return { isError: true, content: [{ type: 'text', text: errMsg }] }
  }

  const logEntry: InvocationLogEntry = {
    ts: new Date().toISOString(),
    capabilityId: req.params.name,
    verdict: result.verdict,
    resolvedVia: result.resolvedVia,
    durationMs: result.durationMs,
    dryRun,
    params: Object.keys(result.match.extractedParams ?? {}),
    error: result.resolution.error ?? null,
  }
  logger.logInvocation(logEntry)

  if (result.missingParams?.length) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Missing required parameters: ${result.missingParams.join(', ')}`,
        },
      ],
    }
  }

  if (!result.resolution.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.resolution.error ?? 'Resolution failed' }],
    }
  }

  const cap = capMap.get(req.params.name)
  const warning = validateEngineResultOutput(result, cap)
  if (warning) {
    process.stderr.write(
      `[capman-mcp] WARN: outputSchema mismatch for "${warning.capabilityId}": ${warning.errors.join('; ')}\n`,
    )
  }

  return { content: buildMcpContent(result) }
}

async function startStdioTransport(server: Server): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('[capman-mcp] MCP server connected via stdio\n')
  await new Promise<void>(resolve => {
    process.on('SIGINT', resolve)
    process.on('SIGTERM', resolve)
  })
}

async function startHttpTransport(server: Server, port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => Math.random().toString(36).slice(2),
  })

  const httpServer = http.createServer(async (req, res) => {
    await transport.handleRequest(req, res)
  })

  await server.connect(transport)
  httpServer.listen(port, () => {
    process.stderr.write(`[capman-mcp] MCP server listening on http://localhost:${port}\n`)
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject)
    process.on('SIGINT', resolve)
    process.on('SIGTERM', resolve)
  })

  await transport.close()
  httpServer.close()
}

/**
 * Start the capman-mcp server from a config file path.
 */
export async function startServer(configPath: string): Promise<void> {
  const config = loadConfig(configPath)
  const manifest = readManifest(config.manifest)
  const registry = config.registryPath ? loadRegistry(config.registryPath) : undefined
  const tools = buildToolList(manifest, config, registry)

  // validateAllowlist is a no-op in registry mode (allowedCapabilities is an
  // override layer, not the approval list).
  if (!config.registryPath) {
    validateAllowlist(config.allowedCapabilities, manifest, tools)
  }

  const capMap = new Map<string, CapabilityWithOutput>(
    manifest.capabilities.map(c => [c.id, c as CapabilityWithOutput]),
  )

  const logger = new InvocationLogger({
    enabled: config.audit?.enabled !== false,
    logFile: config.audit?.logFile,
  })

  const engine = new ConcurrentCapmanEngine({
    manifest,
    baseUrl: config.baseUrl,
    mode: config.mode ?? 'balanced',
    cache: new MemoryCache(),
    learning: new MemoryLearningStore(),
    auth: config.auth
  })

  const server = new Server({ name: 'capman-mcp', version: VERSION }, {
    capabilities: { tools: {} },
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async req =>
    callTool(req, engine, config, logger, capMap),
  )

  process.stderr.write(
    `[capman-mcp] Starting — ${tools.length} tool(s) from ${manifest.capabilities.length} capability(s)\n`,
  )
  process.stderr.write(
    `[capman-mcp] Tools: ${tools.map(t => t.name).join(', ')}\n`,
  )

  if (config.transport === 'http') {
    await startHttpTransport(server, config.httpPort ?? 3000)
  } else {
    await startStdioTransport(server)
  }

  await logger.close()
}

/**
 * Start a demo MCP server with a bundled sample manifest and dryRun: true.
 */
export async function startDemo(): Promise<void> {
  const path = await import('path')
  const demoManifestPath = path.resolve(__dirname, '../..', 'demo', 'manifest.json')
  const demoConfig: CapmanMcpConfig = {
    manifest: demoManifestPath,
    dryRun: true,
    transport: 'stdio',
    allowedCapabilities: [
      { id: 'get_product' },
      { id: 'list_orders' },
      { id: 'get_order' },
      { id: 'check_availability' },
    ],
    audit: { enabled: true },
  }

  const manifest = readManifest(demoConfig.manifest)
  const tools = buildToolList(manifest, demoConfig)

  process.stderr.write('\n╔══════════════════════════════════════╗\n')
  process.stderr.write('║       capman-mcp demo mode           ║\n')
  process.stderr.write('╚══════════════════════════════════════╝\n\n')
  process.stderr.write(`Loaded ${tools.length} demo tool(s): ${tools.map(t => t.name).join(', ')}\n`)
  process.stderr.write('dryRun: true — no real API calls will be made\n\n')
  process.stderr.write('To connect from Claude Desktop, add to your config:\n')
  process.stderr.write('  "command": "npx", "args": ["capman-mcp", "demo"]\n\n')

  const capMap = new Map<string, CapabilityWithOutput>(
    manifest.capabilities.map(c => [c.id, c as CapabilityWithOutput]),
  )
  const logger = new InvocationLogger({ enabled: true, demoMode: true })
  const engine = new ConcurrentCapmanEngine({
    manifest,
    mode: 'cheap',
    cache: new MemoryCache(),
    learning: new MemoryLearningStore(),
  })

  const server = new Server({ name: 'capman-mcp-demo', version: VERSION }, {
    capabilities: { tools: {} },
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async req =>
    callTool(req, engine, demoConfig, logger, capMap),
  )

  await startStdioTransport(server)
  await logger.close()
}
