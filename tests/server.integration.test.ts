/**
 * server.integration.test.ts
 *
 * End-to-end integration test for capman-mcp using the MCP SDK in-process
 * transport. No real network calls, no stdio, no spawned processes.
 *
 * Strategy:
 *   1. Build the same Server + handler setup that startServer() builds,
 *      but driven from a hardcoded test config and a mocked engine.
 *   2. Connect it to an MCP Client via InMemoryTransport.
 *   3. Call tools/list and tools/call through the real MCP protocol layer.
 *
 * The capman ConcurrentCapmanEngine.ask() is mocked — we test the MCP
 * adapter layer (bridge, allowlist, verdict handling, error paths) not
 * the capman matching engine (which has its own test suite in capman/).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ConcurrentCapmanEngine, EngineResult } from 'capman'
import { buildToolList } from '../src/bridge'
import { InvocationLogger } from '../src/logger'
import type { CapmanMcpConfig, CapabilityWithOutput } from '../src/types'
import { callTool } from '../src/server'

// Mock resolveById so registry-mode tests never touch the filesystem or HTTP.
// Each test overrides the return value individually with mockResolvedValue().
vi.mock('../src/resolve', () => ({
  resolveById: vi.fn(),
}))

// ─── Minimal test manifest ────────────────────────────────────────────────────
// A self-contained manifest used for all integration tests.
// Mirrors the shape readManifest() would return — no filesystem read needed.

import type { Manifest } from 'capman'

const TEST_MANIFEST: Manifest = {
  schemaVersion: '1.0.0',
  version: '0.6.3',
  app: 'integration-test-app',
  generatedAt: '2026-06-13T00:00:00.000Z',
  capabilities: [
    {
      id: 'get_order',
      name: 'Get Order',
      description: 'Retrieve an order by ID',
      examples: ['get order ORD-123', 'show order 456'],
      params: [
        {
          name: 'order_id',
          description: 'The order identifier',
          required: true,
          source: 'user_query',
          type: 'string',
          example: 'ORD-123',
        },
      ],
      returns: ['order'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'GET', path: '/orders/{order_id}' }],
      },
      privacy: { level: 'public' },
      lifecycle: { status: 'stable' },
    },
    {
      id: 'list_products',
      name: 'List Products',
      description: 'List all available products',
      examples: ['list products', 'show all products'],
      params: [],
      returns: ['products'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'GET', path: '/products' }],
      },
      privacy: { level: 'public' },
      lifecycle: { status: 'stable' },
    },
    {
      id: 'admin_only',
      name: 'Admin Only',
      description: 'An admin-level capability — must never appear as an MCP tool',
      examples: ['admin action'],
      params: [],
      returns: ['result'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'DELETE', path: '/admin/reset' }],
      },
      privacy: { level: 'admin' },
      lifecycle: { status: 'stable' },
    },
    {
      id: 'deprecated_cap',
      name: 'Deprecated Cap',
      description: 'A deprecated capability — must never appear as an MCP tool',
      examples: ['old thing'],
      params: [],
      returns: ['result'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'GET', path: '/old' }],
      },
      privacy: { level: 'public' },
      lifecycle: { status: 'deprecated' },
    },
  ],
}

// ─── Test config — allowlist only covers 2 of the 4 capabilities ─────────────

const TEST_CONFIG: CapmanMcpConfig = {
  manifest: 'test-manifest.json',
  baseUrl: 'https://api.test.example',
  mode: 'cheap',
  dryRun: true,
  transport: 'stdio',
  allowedCapabilities: [
    { id: 'get_order' },
    { id: 'list_products' },
    // admin_only and deprecated_cap intentionally excluded
  ],
  audit: { enabled: false },
}

// ─── Mock engine result builders ──────────────────────────────────────────────

function makeSuccessResult(data: unknown): EngineResult {
  return {
    match: {
      capability: TEST_MANIFEST.capabilities[0],
      confidence: 100,
      intent: 'retrieval',
      extractedParams: { order_id: 'ORD-123' },
      reasoning: 'Matched via keyword',
      candidates: [{ capabilityId: 'get_order', score: 100, matched: true }],
    },
    resolution: {
      success: true,
      resolverType: 'api',
      data,
      apiCalls: [{ method: 'GET', url: 'https://api.test.example/orders/ORD-123' }],
    },
    resolvedVia: 'keyword',
    durationMs: 5,
    verdict: 'clear',
    margin: 80,
    trace: {
      query: 'get_order order_id ORD-123',
      candidates: [],
      reasoning: [],
      steps: [],
      resolvedVia: 'keyword',
      totalMs: 5,
    },
  } as unknown as EngineResult
}

function makeMissingParamsResult(): EngineResult {
  return {
    match: {
      capability: TEST_MANIFEST.capabilities[0],
      confidence: 90,
      intent: 'retrieval',
      extractedParams: { order_id: null },
      reasoning: 'Matched but param missing',
      candidates: [],
    },
    resolution: {
      success: false,
      resolverType: 'api',
      error: 'Missing required params',
    },
    resolvedVia: 'keyword',
    durationMs: 3,
    verdict: 'clear',
    margin: 80,
    missingParams: ['order_id'],
    trace: {
      query: 'get_order',
      candidates: [],
      reasoning: [],
      steps: [],
      resolvedVia: 'keyword',
      totalMs: 3,
    },
  } as unknown as EngineResult
}

function makeMarginalResult(data: unknown): EngineResult {
  return {
    ...makeSuccessResult(data),
    verdict: 'marginal',
    margin: 5,
  } as unknown as EngineResult
}

// ─── Server factory ───────────────────────────────────────────────────────────
// Wires the real callTool() from server.ts with a mocked engine.ask().
// Any change to callTool's behaviour is exercised by these tests directly.

function buildTestServer(
  mockAsk: ReturnType<typeof vi.fn>,
  config: CapmanMcpConfig = TEST_CONFIG,
  manifest: Manifest = TEST_MANIFEST,
) {
  const tools = buildToolList(manifest, config)
  const capMap = new Map<string, CapabilityWithOutput>(
    manifest.capabilities.map(c => [c.id, c as CapabilityWithOutput]),
  )
  const logger = new InvocationLogger({ enabled: false })
  const mockEngine = { ask: mockAsk } as unknown as ConcurrentCapmanEngine

  const server = new Server(
    { name: 'capman-mcp-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async req =>
    callTool(req, mockEngine, config, logger, capMap),
  )

  return server
}

// ─── Transport helper ─────────────────────────────────────────────────────────
// Creates a linked in-process transport pair, connects server + client,
// and returns the client ready to send requests.

async function connectInProcess(server: Server): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()

  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  )

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  return client
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('capman-mcp MCP server integration', () => {
  let mockAsk: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockAsk = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── tools/list ──────────────────────────────────────────────────────────────

  describe('tools/list', () => {
    it('returns only the approved public stable tools', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const response = await client.listTools()

      const names = response.tools.map((t: { name: string }) => t.name)
      expect(names).toContain('get_order')
      expect(names).toContain('list_products')
      // admin_only: filtered by privacy level
      expect(names).not.toContain('admin_only')
      // deprecated_cap: filtered by lifecycle status
      expect(names).not.toContain('deprecated_cap')
      // not in allowlist
      expect(names).not.toContain('unlisted_tool')
    })

    it('each tool has name, description, and inputSchema', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      const orderTool = response.tools.find((t: { name: string }) => t.name === 'get_order')

      expect(orderTool).toBeDefined()
      expect(typeof orderTool!.description).toBe('string')
      expect(orderTool!.description.length).toBeGreaterThan(0)
      expect(orderTool!.inputSchema).toBeDefined()
      expect(orderTool!.inputSchema.type).toBe('object')
    })

    it('get_order inputSchema marks order_id as required', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      const orderTool = response.tools.find((t: { name: string }) => t.name === 'get_order')

      const schema = orderTool!.inputSchema as {
        properties: Record<string, unknown>
        required: string[]
      }
      expect(schema.properties).toHaveProperty('order_id')
      expect(schema.required).toContain('order_id')
    })

    it('list_products inputSchema has no required params', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      const productTool = response.tools.find((t: { name: string }) => t.name === 'list_products')

      const schema = productTool!.inputSchema as { required: string[] }
      expect(schema.required).toHaveLength(0)
    })

    it('descriptionOverride replaces the capability description', async () => {
      const configWithOverride: CapmanMcpConfig = {
        ...TEST_CONFIG,
        allowedCapabilities: [
          { id: 'get_order', descriptionOverride: 'Custom tool description' },
          { id: 'list_products' },
        ],
      }
      const server = buildTestServer(mockAsk, configWithOverride)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      const orderTool = response.tools.find((t: { name: string }) => t.name === 'get_order')

      expect(orderTool!.description).toBe('Custom tool description')
    })
  })

  // ── tools/call — success paths ─────────────────────────────────────────────

  describe('tools/call — success', () => {
    it('returns structured data from a successful resolution', async () => {
      mockAsk.mockResolvedValue(makeSuccessResult({ id: 'ORD-123', status: 'shipped' }))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'get_order',
        arguments: { order_id: 'ORD-123' },
      }) as CallToolResult

      expect(result.isError).toBeFalsy()
      expect(result.content).toHaveLength(1)
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('ORD-123')
      expect(text).toContain('shipped')
    })

    it('forwards the query string to engine.ask()', async () => {
      mockAsk.mockResolvedValue(makeSuccessResult({ id: 'ORD-456' }))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      await client.callTool({
        name: 'get_order',
        arguments: { order_id: 'ORD-456' },
      })

      expect(mockAsk).toHaveBeenCalledOnce()
      const calledQuery = mockAsk.mock.calls[0][0] as string
      // Query must contain tool name and param value
      expect(calledQuery).toContain('get_order')
      expect(calledQuery).toContain('ORD-456')
    })

    it('passes dryRun: true from config to engine.ask()', async () => {
      mockAsk.mockResolvedValue(makeSuccessResult({}))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      await client.callTool({ name: 'get_order', arguments: { order_id: 'X' } })

      const calledOptions = mockAsk.mock.calls[0][1] as { dryRun: boolean }
      expect(calledOptions.dryRun).toBe(true)
    })

    it('dryRunOverride on an entry overrides the global dryRun', async () => {
      mockAsk.mockResolvedValue(makeSuccessResult({}))

      const configWithOverride: CapmanMcpConfig = {
        ...TEST_CONFIG,
        dryRun: true,
        allowedCapabilities: [
          { id: 'get_order', dryRunOverride: false },
          { id: 'list_products' },
        ],
      }
      const server = buildTestServer(mockAsk, configWithOverride)
      const client = await connectInProcess(server)

      await client.callTool({ name: 'get_order', arguments: { order_id: 'X' } })

      const calledOptions = mockAsk.mock.calls[0][1] as { dryRun: boolean }
      expect(calledOptions.dryRun).toBe(false)
    })

    it('annotates response with [verdict: marginal] when verdict is not clear', async () => {
      mockAsk.mockResolvedValue(makeMarginalResult({ id: 'ORD-789' }))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'get_order',
        arguments: { order_id: 'ORD-789' },
      }) as CallToolResult

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('[verdict: marginal]')
    })

    it('returns OK text when resolution data is empty', async () => {
      mockAsk.mockResolvedValue(makeSuccessResult(undefined))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'list_products',
        arguments: {},
      }) as CallToolResult

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toBe('OK')
    })
  })

  // ── tools/call — error paths ───────────────────────────────────────────────

  describe('tools/call — error paths', () => {
    it('returns isError when tool name is not in the allowlist', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'admin_only',
        arguments: {},
      }) as CallToolResult

      expect(result.isError).toBe(true)
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('not approved')
      // engine should never be called for unapproved tools
      expect(mockAsk).not.toHaveBeenCalled()
    })

    it('returns isError with param names when missingParams is populated', async () => {
      mockAsk.mockResolvedValue(makeMissingParamsResult())

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'get_order',
        arguments: {},
      }) as CallToolResult

      expect(result.isError).toBe(true)
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('Missing required parameters')
      expect(text).toContain('order_id')
    })

    it('returns isError when resolution fails', async () => {
      mockAsk.mockResolvedValue({
        ...makeSuccessResult(null),
        resolution: {
          success: false,
          resolverType: 'api',
          error: 'upstream timeout',
        },
        missingParams: undefined,
      })

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'get_order',
        arguments: { order_id: 'ORD-999' },
      }) as CallToolResult

      expect(result.isError).toBe(true)
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('upstream timeout')
    })

    it('returns isError when engine.ask() throws', async () => {
      mockAsk.mockRejectedValue(new Error('engine exploded'))

      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const result = await client.callTool({
        name: 'get_order',
        arguments: { order_id: 'X' },
      }) as CallToolResult

      expect(result.isError).toBe(true)
      const text = (result.content[0] as { type: string; text: string }).text
      expect(text).toContain('engine exploded')
    })
  })

    // ── Registry mode — callTool ───────────────────────────────────────────────
    // Tests the config.registryPath branch in callTool() which calls resolveById()
    // instead of engine.ask(). resolveById is mocked at module level above.

    describe('registry mode — callTool', () => {
      // Registry config: registryPath set, allowedCapabilities used only as
      // override layer. Approval gate is capMap membership (set by buildToolList).
      const REGISTRY_CONFIG: CapmanMcpConfig = {
        ...TEST_CONFIG,
        registryPath: '/tmp/test-registry.json',
        // allowedCapabilities still present for dryRunOverride/descriptionOverride;
        // in registry mode buildToolList uses registry entries for approval gating.
        allowedCapabilities: [],
      }

      it('calls resolveById (not engine.ask) when registryPath is set', async () => {
        const { resolveById } = await import('../src/resolve')
        const mockResolveById = resolveById as ReturnType<typeof vi.fn>
        mockResolveById.mockResolvedValue(makeSuccessResult({ id: 'ORD-123', status: 'shipped' }))

        // In registry mode, approval = capMap.has(toolName). Build capMap manually
        // to include get_order as approved.
        const capMap = new Map<string, CapabilityWithOutput>(
          TEST_MANIFEST.capabilities.map(c => [c.id, c as CapabilityWithOutput]),
        )
        const logger = new InvocationLogger({ enabled: false })
        const server = new Server(
          { name: 'capman-mcp-registry-test', version: '0.0.0' },
          { capabilities: { tools: {} } },
        )
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
        server.setRequestHandler(CallToolRequestSchema, async req =>
          callTool(req, { ask: mockAsk } as unknown as ConcurrentCapmanEngine, REGISTRY_CONFIG, logger, capMap),
        )
        const client = await connectInProcess(server)

        const result = await client.callTool({
          name: 'get_order',
          arguments: { order_id: 'ORD-123' },
        }) as CallToolResult

        expect(result.isError).toBeFalsy()
        // resolveById must have been called — engine.ask must NOT have been called
        expect(mockResolveById).toHaveBeenCalledOnce()
        expect(mockResolveById).toHaveBeenCalledWith(
          'get_order',
          { order_id: 'ORD-123' },
          capMap,
          expect.objectContaining({ dryRun: true }),
        )
        expect(mockAsk).not.toHaveBeenCalled()
      })

      it('returns isError for a tool not in capMap (registry approval gate)', async () => {
        // capMap is empty — no tool is approved
        const capMap = new Map<string, CapabilityWithOutput>()
        const logger = new InvocationLogger({ enabled: false })
        const server = new Server(
          { name: 'capman-mcp-registry-gate-test', version: '0.0.0' },
          { capabilities: { tools: {} } },
        )
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
        server.setRequestHandler(CallToolRequestSchema, async req =>
          callTool(req, { ask: mockAsk } as unknown as ConcurrentCapmanEngine, REGISTRY_CONFIG, logger, capMap),
        )
        const client = await connectInProcess(server)

        const result = await client.callTool({
          name: 'get_order',
          arguments: {},
        }) as CallToolResult

        expect(result.isError).toBe(true)
        const text = (result.content[0] as { type: string; text: string }).text
        expect(text).toContain('not approved')
        expect(mockAsk).not.toHaveBeenCalled()
      })

      it('returns isError when resolveById throws', async () => {
        const { resolveById } = await import('../src/resolve')
        const mockResolveById = resolveById as ReturnType<typeof vi.fn>
        mockResolveById.mockRejectedValue(new Error('resolve exploded'))

        const capMap = new Map<string, CapabilityWithOutput>(
          TEST_MANIFEST.capabilities.map(c => [c.id, c as CapabilityWithOutput]),
        )
        const logger = new InvocationLogger({ enabled: false })
        const server = new Server(
          { name: 'capman-mcp-registry-throw-test', version: '0.0.0' },
          { capabilities: { tools: {} } },
        )
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
        server.setRequestHandler(CallToolRequestSchema, async req =>
          callTool(req, { ask: mockAsk } as unknown as ConcurrentCapmanEngine, REGISTRY_CONFIG, logger, capMap),
        )
        const client = await connectInProcess(server)

        const result = await client.callTool({
          name: 'get_order',
          arguments: { order_id: 'X' },
        }) as CallToolResult

        expect(result.isError).toBe(true)
        const text = (result.content[0] as { type: string; text: string }).text
        expect(text).toContain('resolve exploded')
      })
    })

    // ── Allowlist / filter invariants ──────────────────────────────────────────

  describe('allowlist and filter invariants', () => {
    it('tool count matches allowedCapabilities that pass all filters', async () => {
      const server = buildTestServer(mockAsk)
      const client = await connectInProcess(server)

      const response = await client.listTools()

      // 4 capabilities total: 2 in allowlist, 1 admin, 1 deprecated
      // Only the 2 allowlisted public stable ones should appear
      expect(response.tools).toHaveLength(2)
    })

    it('an empty allowedCapabilities produces zero tools', async () => {
      const emptyConfig: CapmanMcpConfig = { ...TEST_CONFIG, allowedCapabilities: [] }
      const server = buildTestServer(mockAsk, emptyConfig)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      expect(response.tools).toHaveLength(0)
    })

    it('a non-existent allowlist id produces zero tools for that id', async () => {
      const configWithBadId: CapmanMcpConfig = {
        ...TEST_CONFIG,
        allowedCapabilities: [{ id: 'does_not_exist' }],
      }
      const server = buildTestServer(mockAsk, configWithBadId)
      const client = await connectInProcess(server)

      const response = await client.listTools()
      expect(response.tools).toHaveLength(0)
    })
  })
})