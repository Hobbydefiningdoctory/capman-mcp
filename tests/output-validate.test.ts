import { describe, it, expect } from 'vitest'
import { validateEngineResultOutput } from '../src/output-validate'
import type { EngineResult } from 'capman'
import type { CapabilityWithOutput } from '../src/types'

function makeResult(data: unknown, success = true): EngineResult {
  return {
    match: {
      capability: null,
      confidence: 100,
      intent: 'retrieval',
      extractedParams: {},
      reasoning: '',
      candidates: [],
    },
    resolution: { success, resolverType: 'api', data },
    resolvedVia: 'keyword',
    durationMs: 10,
    verdict: 'clear',
    margin: 100,
    trace: { query: '', candidates: [], reasoning: [], steps: [], resolvedVia: 'keyword', totalMs: 10 },
  } as unknown as EngineResult
}

function makeCap(outputSchema: CapabilityWithOutput['outputSchema']): CapabilityWithOutput {
  return {
    id: 'get_order',
    name: 'Get Order',
    description: '',
    privacy: { level: 'public' },
    lifecycle: { status: 'stable' },
    params: [],
    resolver: { type: 'api', endpoints: [] },
    examples: [],
    outputSchema,
  } as unknown as CapabilityWithOutput
}

describe('validateEngineResultOutput', () => {
  it('returns null when no outputSchema', () => {
    const result = makeResult({ order_id: '1' })
    const cap = makeCap(undefined)
    expect(validateEngineResultOutput(result, cap)).toBeNull()
  })

  it('returns null when cap is undefined', () => {
    const result = makeResult({ order_id: '1' })
    expect(validateEngineResultOutput(result, undefined)).toBeNull()
  })

  it('returns null when resolution failed', () => {
    const result = makeResult(null, false)
    const cap = makeCap({
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    })
    expect(validateEngineResultOutput(result, cap)).toBeNull()
  })

  it('returns null when data matches schema', () => {
    const result = makeResult({ order_id: 'ORD-1' })
    const cap = makeCap({
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    })
    expect(validateEngineResultOutput(result, cap)).toBeNull()
  })

  it('returns warning when required field is missing', () => {
    const result = makeResult({ status: 'ok' })
    const cap = makeCap({
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['order_id'],
    })
    const warning = validateEngineResultOutput(result, cap)
    expect(warning).not.toBeNull()
    expect(warning?.capabilityId).toBe('get_order')
    expect(warning?.errors.some(e => e.includes('order_id'))).toBe(true)
  })

  it('returns warning when data is not an object', () => {
    const result = makeResult('just a string')
    const cap = makeCap({
      type: 'object',
      properties: { order_id: { type: 'string' } },
    })
    const warning = validateEngineResultOutput(result, cap)
    expect(warning).not.toBeNull()
    expect(warning?.errors[0]).toMatch(/expected object/)
  })
})
