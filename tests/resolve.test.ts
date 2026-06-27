import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolveResult } from 'capman'
import type { CapabilityWithOutput } from '../src/types'

// Mock capman.resolve before importing resolveById so vitest hoisting works.
vi.mock('capman', async importOriginal => {
  const actual = await importOriginal<typeof import('capman')>()
  return { ...actual, resolve: vi.fn() }
})

import { resolve } from 'capman'
import { resolveById } from '../src/resolve'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCapMap(id: string): Map<string, CapabilityWithOutput> {
  const cap = {
    id,
    name: id,
    description: 'Test cap',
    params: [],
    resolver: { type: 'api', endpoints: [] },
    privacy: { level: 'public' },
    lifecycle: { status: 'stable' },
    examples: [],
  } as unknown as CapabilityWithOutput
  return new Map([[id, cap]])
}

function makeResolveResult(overrides: Partial<ResolveResult> = {}): ResolveResult {
  return {
    success: true,
    resolverType: 'api',
    data: { order_id: 'ORD-1', status: 'shipped' },
    apiCalls: [{ method: 'GET', url: 'https://api.test/orders/ORD-1', params: {} }],
    ...overrides,
  } as unknown as ResolveResult
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('resolveById', () => {
  const mockResolve = vi.mocked(resolve)

  beforeEach(() => {
    mockResolve.mockReset()
  })

  it('calls capman.resolve with the matched capability and params', async () => {
    mockResolve.mockResolvedValue(makeResolveResult())
    const capMap = makeCapMap('get_order')

    await resolveById('get_order', { order_id: 'ORD-1' }, capMap)

    expect(mockResolve).toHaveBeenCalledOnce()
    const [matchResult, params] = mockResolve.mock.calls[0]
    expect(matchResult.capability?.id).toBe('get_order')
    expect(matchResult.confidence).toBe(100)
    expect(params).toEqual({ order_id: 'ORD-1' })
  })

  it('returns EngineResult with verdict "clear" and margin 100', async () => {
    mockResolve.mockResolvedValue(makeResolveResult())
    const result = await resolveById('get_order', {}, makeCapMap('get_order'))

    expect(result.verdict).toBe('clear')
    expect(result.margin).toBe(100)
    expect(result.resolvedVia).toBe('keyword')
  })

  it('propagates dryRun option through to capman.resolve', async () => {
    mockResolve.mockResolvedValue(makeResolveResult())
    await resolveById('get_order', {}, makeCapMap('get_order'), { dryRun: true })

    const [, , options] = mockResolve.mock.calls[0]
    expect(options?.dryRun).toBe(true)
  })

  it('propagates baseUrl option through to capman.resolve', async () => {
    mockResolve.mockResolvedValue(makeResolveResult())
    await resolveById('get_order', {}, makeCapMap('get_order'), {
      baseUrl: 'https://api.example.com',
    })

    const [, , options] = mockResolve.mock.calls[0]
    expect(options?.baseUrl).toBe('https://api.example.com')
  })

  it('returns uncertain result when capability is not in capMap', async () => {
    const capMap = makeCapMap('other_cap')
    const result = await resolveById('nonexistent', {}, capMap)

    expect(result.verdict).toBe('uncertain')
    expect(result.resolution.success).toBe(false)
    expect(result.resolution.error).toContain('nonexistent')
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('surfaces resolution.data from capman.resolve result', async () => {
    const data = { id: 'ORD-1', status: 'shipped' }
    mockResolve.mockResolvedValue(makeResolveResult({ data }))
    const result = await resolveById('get_order', {}, makeCapMap('get_order'))

    expect(result.resolution.data).toEqual(data)
  })

  it('coerces non-string params to string in extractedParams', async () => {
    mockResolve.mockResolvedValue(makeResolveResult())
    await resolveById('get_order', { count: 42, active: true }, makeCapMap('get_order'))

    const [matchResult] = mockResolve.mock.calls[0]
    expect(matchResult.extractedParams).toEqual({ count: '42', active: 'true' })
  })
})
