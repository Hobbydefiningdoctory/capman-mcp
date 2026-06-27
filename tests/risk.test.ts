/**
 * risk.test.ts — Unit tests for deriveRiskLevel() and maxRisk().
 *
 * Covers all five derivation rules, all boundary conditions, resolver type
 * variants (api / nav / hybrid), multi-method worst-case, financial keyword
 * matching, and undefined/empty fields.
 */

import { describe, it, expect } from 'vitest'
import { deriveRiskLevel, maxRisk } from '../src/risk'
import type { Capability } from 'capman'

// ── Builder helper ────────────────────────────────────────────────────────────

type BuilderOpts = {
  method?:      'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  methods?:     Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'>
  privacy?:     'public' | 'user_owned' | 'admin'
  errorCodes?:  string[]
  resolver?:    'api' | 'nav' | 'hybrid'
}

function makeCap(opts: BuilderOpts = {}): Capability {
  const {
    method      = 'GET',
    methods,
    privacy     = 'public',
    errorCodes  = [],
    resolver    = 'api',
  } = opts

  const allMethods = methods ?? [method]
  const endpoints  = allMethods.map(m => ({ method: m, path: '/items' }))

  const resolverObj =
    resolver === 'nav'
      ? { type: 'nav' as const, destination: '/dashboard' }
      : resolver === 'hybrid'
      ? { type: 'hybrid' as const, api: { endpoints }, nav: { destination: '/dashboard' } }
      : { type: 'api' as const, endpoints }

  return {
    id: 'test_cap',
    name: 'Test',
    description: 'Test capability',
    examples: [],
    params: [],
    returns: ['result'],
    resolver: resolverObj,
    privacy: { level: privacy },
    lifecycle: { status: 'stable' },
    errors: errorCodes.map(code => ({ code, description: code })),
  } as unknown as Capability
}

// ── Rule 1 — admin privacy ────────────────────────────────────────────────────

describe('Rule 1 — admin privacy → high', () => {
  it('GET + admin → high', () => {
    expect(deriveRiskLevel(makeCap({ privacy: 'admin' }))).toBe('high')
  })
  it('POST + admin → high (not just medium from mutating)', () => {
    expect(deriveRiskLevel(makeCap({ method: 'POST', privacy: 'admin' }))).toBe('high')
  })
  it('DELETE + admin → high', () => {
    expect(deriveRiskLevel(makeCap({ method: 'DELETE', privacy: 'admin' }))).toBe('high')
  })
  it('nav resolver + admin → high', () => {
    expect(deriveRiskLevel(makeCap({ resolver: 'nav', privacy: 'admin' }))).toBe('high')
  })
})

// ── Rule 2 — financial error codes ───────────────────────────────────────────

describe('Rule 2 — financial error codes → high', () => {
  const keywords = [
    'PAYMENT_FAILED',
    'CHARGE_DECLINED',
    'BILLING_ERROR',
    'FINANCIAL_LIMIT',
    'REFUND_NOT_ALLOWED',
    'INVOICE_OVERDUE',
    'SUBSCRIPTION_EXPIRED',
  ]

  for (const code of keywords) {
    it(`"${code}" → high`, () => {
      expect(deriveRiskLevel(makeCap({ errorCodes: [code] }))).toBe('high')
    })
  }

  it('keyword matching is case-insensitive', () => {
    expect(deriveRiskLevel(makeCap({ errorCodes: ['payment_failed'] }))).toBe('high')
    expect(deriveRiskLevel(makeCap({ errorCodes: ['Payment_Failed'] }))).toBe('high')
  })

  it('keyword matched as substring', () => {
    expect(deriveRiskLevel(makeCap({ errorCodes: ['ORDER_REFUND_FAILED'] }))).toBe('high')
  })

  it('one financial + many non-financial → high', () => {
    expect(
      deriveRiskLevel(makeCap({ errorCodes: ['NOT_FOUND', 'PAYMENT_FAILED', 'RATE_LIMIT'] })),
    ).toBe('high')
  })

  it('non-financial codes only → not high', () => {
    expect(
      deriveRiskLevel(makeCap({ errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] })),
    ).toBe('low')
  })

  it('empty errors array → not high', () => {
    expect(deriveRiskLevel(makeCap({ errorCodes: [] }))).toBe('low')
  })

  it('undefined errors → not high', () => {
    const cap = makeCap({ privacy: 'public' })
    ;(cap as Record<string, unknown>).errors = undefined
    expect(deriveRiskLevel(cap)).toBe('low')
  })

  it('GET + public + financial → high (rule 2 beats rule 5)', () => {
    expect(
      deriveRiskLevel(makeCap({ method: 'GET', privacy: 'public', errorCodes: ['INVOICE_MISSING'] })),
    ).toBe('high')
  })
})

// ── Rule 3 — mutating methods ─────────────────────────────────────────────────

describe('Rule 3 — mutating method → medium', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    it(`${method} + public + no financial → medium`, () => {
      expect(deriveRiskLevel(makeCap({ method, privacy: 'public' }))).toBe('medium')
    })
  }

  it('GET + public → low (not medium)', () => {
    expect(deriveRiskLevel(makeCap({ method: 'GET' }))).toBe('low')
  })

  it('HEAD + public → low', () => {
    expect(deriveRiskLevel(makeCap({ method: 'HEAD' }))).toBe('low')
  })

  it('OPTIONS + public → low', () => {
    expect(deriveRiskLevel(makeCap({ method: 'OPTIONS' }))).toBe('low')
  })

  it('DELETE + financial → high (rule 2 beats rule 3)', () => {
    expect(
      deriveRiskLevel(makeCap({ method: 'DELETE', errorCodes: ['SUBSCRIPTION_CANCEL'] })),
    ).toBe('high')
  })

  it('multi-endpoint GET + DELETE → medium (worst method wins)', () => {
    expect(
      deriveRiskLevel(makeCap({ methods: ['GET', 'DELETE'], privacy: 'public' })),
    ).toBe('medium')
  })

  it('multi-endpoint GET + HEAD → low (all safe)', () => {
    expect(
      deriveRiskLevel(makeCap({ methods: ['GET', 'HEAD'], privacy: 'public' })),
    ).toBe('low')
  })

  it('hybrid resolver POST + public → medium', () => {
    expect(
      deriveRiskLevel(makeCap({ method: 'POST', resolver: 'hybrid', privacy: 'public' })),
    ).toBe('medium')
  })
})

// ── Rule 4 — user_owned ───────────────────────────────────────────────────────

describe('Rule 4 — user_owned → medium', () => {
  it('GET + user_owned → medium', () => {
    expect(deriveRiskLevel(makeCap({ privacy: 'user_owned' }))).toBe('medium')
  })

  it('HEAD + user_owned → medium', () => {
    expect(deriveRiskLevel(makeCap({ method: 'HEAD', privacy: 'user_owned' }))).toBe('medium')
  })

  it('user_owned + financial → high (rule 2 beats rule 4)', () => {
    expect(
      deriveRiskLevel(makeCap({ privacy: 'user_owned', errorCodes: ['PAYMENT_REQUIRED'] })),
    ).toBe('high')
  })

  it('nav + user_owned → medium (rule 4 applies without HTTP method)', () => {
    expect(deriveRiskLevel(makeCap({ resolver: 'nav', privacy: 'user_owned' }))).toBe('medium')
  })
})

// ── Rule 5 — low ─────────────────────────────────────────────────────────────

describe('Rule 5 — GET + public → low', () => {
  it('GET + public + no errors → low', () => {
    expect(deriveRiskLevel(makeCap())).toBe('low')
  })

  it('HEAD + public → low', () => {
    expect(deriveRiskLevel(makeCap({ method: 'HEAD' }))).toBe('low')
  })

  it('OPTIONS + public → low', () => {
    expect(deriveRiskLevel(makeCap({ method: 'OPTIONS' }))).toBe('low')
  })

  it('nav-only + public → low (no HTTP method = GET-equivalent)', () => {
    expect(deriveRiskLevel(makeCap({ resolver: 'nav', privacy: 'public' }))).toBe('low')
  })

  it('hybrid GET + public → low', () => {
    expect(deriveRiskLevel(makeCap({ resolver: 'hybrid', method: 'GET' }))).toBe('low')
  })
})

// ── maxRisk() ─────────────────────────────────────────────────────────────────

describe('maxRisk()', () => {
  it('low vs medium → medium',  () => expect(maxRisk('low', 'medium')).toBe('medium'))
  it('medium vs low → medium',  () => expect(maxRisk('medium', 'low')).toBe('medium'))
  it('low vs high → high',      () => expect(maxRisk('low', 'high')).toBe('high'))
  it('high vs low → high',      () => expect(maxRisk('high', 'low')).toBe('high'))
  it('medium vs high → high',   () => expect(maxRisk('medium', 'high')).toBe('high'))
  it('same level → same',       () => {
    expect(maxRisk('low', 'low')).toBe('low')
    expect(maxRisk('medium', 'medium')).toBe('medium')
    expect(maxRisk('high', 'high')).toBe('high')
  })
})

// ── Real-world snapshots ──────────────────────────────────────────────────────

describe('real-world snapshots', () => {
  it('GET /products (public catalog) → low',          () => expect(deriveRiskLevel(makeCap())).toBe('low'))
  it('GET /orders (user_owned) → medium',             () => expect(deriveRiskLevel(makeCap({ privacy: 'user_owned' }))).toBe('medium'))
  it('DELETE /orders/:id (public) → medium',          () => expect(deriveRiskLevel(makeCap({ method: 'DELETE' }))).toBe('medium'))
  it('POST /payments (financial errors) → high',      () => expect(deriveRiskLevel(makeCap({ method: 'POST', errorCodes: ['PAYMENT_DECLINED'] }))).toBe('high'))
  it('GET /admin/users (admin privacy) → high',       () => expect(deriveRiskLevel(makeCap({ privacy: 'admin' }))).toBe('high'))
  it('nav → /checkout (public) → low',                () => expect(deriveRiskLevel(makeCap({ resolver: 'nav' }))).toBe('low'))
})