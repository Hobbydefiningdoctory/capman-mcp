/**
 * graph.test.ts — Unit tests for buildDependencyGraph(), detectCycles(),
 * getImpactedCapabilities(), and CycleError.
 *
 * All tests use in-memory RegistryEntry fixtures — no filesystem access.
 */

import { describe, it, expect } from 'vitest'
import {
  buildDependencyGraph,
  detectCycles,
  getImpactedCapabilities,
  CycleError,
} from '../src/graph'
import type { RegistryEntry } from '../src/types'

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeEntry(
  fqId: string,
  dependsOn: string[] = [],
): RegistryEntry {
  return {
    fullyQualifiedId: fqId,
    schemaVersion:    '1.0.0',
    owner:            'test',
    status:           'stable',
    schemaHash:       `hash-${fqId}`,
    approvedForMcp:   true,
    riskLevel:        'low',
    publishedAt:      '2026-01-01T00:00:00.000Z',
    dependsOn,
  }
}

// ── buildDependencyGraph ──────────────────────────────────────────────────────

describe('buildDependencyGraph()', () => {
  it('returns empty graph for empty entries', () => {
    const g = buildDependencyGraph([])
    expect(g.size).toBe(0)
  })

  it('single entry with no dependsOn — added as node with empty edges', () => {
    const g = buildDependencyGraph([makeEntry('app/a')])
    expect(g.has('app/a')).toBe(true)
    expect(g.get('app/a')!.size).toBe(0)
  })

  it('single entry with dependsOn — adds edge and dangling dep as node', () => {
    const g = buildDependencyGraph([makeEntry('app/a', ['app/b'])])
    expect(g.has('app/a')).toBe(true)
    expect(g.get('app/a')!.has('app/b')).toBe(true)
    // dangling dep 'app/b' is added as node even though it has no entry
    expect(g.has('app/b')).toBe(true)
    expect(g.get('app/b')!.size).toBe(0)
  })

  it('two entries with a dependency between them', () => {
    const g = buildDependencyGraph([
      makeEntry('app/summary', ['app/get_order']),
      makeEntry('app/get_order'),
    ])
    expect(g.get('app/summary')!.has('app/get_order')).toBe(true)
    expect(g.get('app/get_order')!.size).toBe(0)
  })

  it('multiple entries — only those with dependsOn have edges', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b', 'app/c']),
      makeEntry('app/b'),
      makeEntry('app/c'),
      makeEntry('app/d'),  // isolated
    ])
    expect(g.size).toBe(4)
    expect(g.get('app/a')!.size).toBe(2)
    expect(g.get('app/b')!.size).toBe(0)
    expect(g.get('app/d')!.size).toBe(0)
  })

  it('empty dependsOn array treated the same as absent dependsOn', () => {
    const g = buildDependencyGraph([makeEntry('app/a', [])])
    expect(g.get('app/a')!.size).toBe(0)
  })

  it('undefined dependsOn (old entries) treated as no edges', () => {
    const entry = makeEntry('app/a')
    delete (entry as Record<string, unknown>).dependsOn
    const g = buildDependencyGraph([entry])
    expect(g.get('app/a')!.size).toBe(0)
  })
})

// ── detectCycles ──────────────────────────────────────────────────────────────

describe('detectCycles()', () => {
  it('empty graph — no throw', () => {
    expect(() => detectCycles(buildDependencyGraph([]))).not.toThrow()
  })

  it('single node no deps — no throw', () => {
    const g = buildDependencyGraph([makeEntry('app/a')])
    expect(() => detectCycles(g)).not.toThrow()
  })

  it('linear chain A → B → C — no throw', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b']),
      makeEntry('app/b', ['app/c']),
      makeEntry('app/c'),
    ])
    expect(() => detectCycles(g)).not.toThrow()
  })

  it('diamond (A → B, A → C, B → D, C → D) — no throw (not a cycle)', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b', 'app/c']),
      makeEntry('app/b', ['app/d']),
      makeEntry('app/c', ['app/d']),
      makeEntry('app/d'),
    ])
    expect(() => detectCycles(g)).not.toThrow()
  })

  it('direct self-loop A → A — throws CycleError', () => {
    const g = buildDependencyGraph([makeEntry('app/a', ['app/a'])])
    expect(() => detectCycles(g)).toThrow(CycleError)
  })

  it('direct mutual cycle A → B → A — throws CycleError', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b']),
      makeEntry('app/b', ['app/a']),
    ])
    expect(() => detectCycles(g)).toThrow(CycleError)
  })

  it('transitive cycle A → B → C → A — throws CycleError', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b']),
      makeEntry('app/b', ['app/c']),
      makeEntry('app/c', ['app/a']),
    ])
    expect(() => detectCycles(g)).toThrow(CycleError)
  })

  it('cycle in a subgraph with isolated nodes — still throws', () => {
    const g = buildDependencyGraph([
      makeEntry('app/isolated'),
      makeEntry('app/x', ['app/y']),
      makeEntry('app/y', ['app/x']),
    ])
    expect(() => detectCycles(g)).toThrow(CycleError)
  })

  it('longer cycle A → B → C → D → B — throws CycleError', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b']),
      makeEntry('app/b', ['app/c']),
      makeEntry('app/c', ['app/d']),
      makeEntry('app/d', ['app/b']),  // back edge to b
    ])
    expect(() => detectCycles(g)).toThrow(CycleError)
  })
})

// ── CycleError shape ──────────────────────────────────────────────────────────

describe('CycleError', () => {
  it('is an instance of Error', () => {
    const err = new CycleError(['app/a', 'app/b', 'app/a'])
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CycleError)
  })

  it('name is CycleError', () => {
    const err = new CycleError(['app/a', 'app/b', 'app/a'])
    expect(err.name).toBe('CycleError')
  })

  it('message contains the cycle path', () => {
    const err = new CycleError(['app/a', 'app/b', 'app/a'])
    expect(err.message).toContain('app/a')
    expect(err.message).toContain('app/b')
    expect(err.message).toContain('→')
  })

  it('cyclePath array is stored correctly', () => {
    const path = ['app/a', 'app/b', 'app/c', 'app/a']
    const err = new CycleError(path)
    expect(err.cyclePath).toEqual(path)
  })

  it('direct cycle detected by detectCycles has a non-empty cyclePath', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a', ['app/b']),
      makeEntry('app/b', ['app/a']),
    ])
    try {
      detectCycles(g)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CycleError)
      const err = e as CycleError
      expect(err.cyclePath.length).toBeGreaterThanOrEqual(2)
      // First and last element should be the same (closed loop)
      expect(err.cyclePath[0]).toBe(err.cyclePath[err.cyclePath.length - 1])
    }
  })
})

// ── getImpactedCapabilities ───────────────────────────────────────────────────

describe('getImpactedCapabilities()', () => {
  it('no dependents — returns empty array', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a'),
      makeEntry('app/b'),
    ])
    expect(getImpactedCapabilities(g, 'app/a')).toEqual([])
  })

  it('fqId not in graph — returns empty array', () => {
    const g = buildDependencyGraph([makeEntry('app/a')])
    expect(getImpactedCapabilities(g, 'app/unknown')).toEqual([])
  })

  it('direct dependent: summary depends on get_order', () => {
    const g = buildDependencyGraph([
      makeEntry('app/get_order'),
      makeEntry('app/summary', ['app/get_order']),
    ])
    expect(getImpactedCapabilities(g, 'app/get_order')).toEqual(['app/summary'])
  })

  it('two direct dependents', () => {
    const g = buildDependencyGraph([
      makeEntry('app/base'),
      makeEntry('app/consumer_a', ['app/base']),
      makeEntry('app/consumer_b', ['app/base']),
    ])
    const result = getImpactedCapabilities(g, 'app/base')
    expect(result).toEqual(['app/consumer_a', 'app/consumer_b'])
  })

  it('transitive dependents: A → B → C, change C impacts both B and A', () => {
    const g = buildDependencyGraph([
      makeEntry('app/c'),
      makeEntry('app/b', ['app/c']),
      makeEntry('app/a', ['app/b']),
    ])
    const result = getImpactedCapabilities(g, 'app/c')
    expect(result).toContain('app/b')
    expect(result).toContain('app/a')
    expect(result).not.toContain('app/c')  // seed excluded
  })

  it('diamond: A→B, A→C, B→D, C→D — changing D impacts B, C, and A', () => {
    const g = buildDependencyGraph([
      makeEntry('app/d'),
      makeEntry('app/b', ['app/d']),
      makeEntry('app/c', ['app/d']),
      makeEntry('app/a', ['app/b', 'app/c']),
    ])
    const result = getImpactedCapabilities(g, 'app/d')
    expect(result).toContain('app/b')
    expect(result).toContain('app/c')
    expect(result).toContain('app/a')
    expect(result).not.toContain('app/d')
    // No duplicates
    expect(result.length).toBe(3)
  })

  it('seed excluded from result even if in graph', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a'),
      makeEntry('app/b', ['app/a']),
    ])
    const result = getImpactedCapabilities(g, 'app/a')
    expect(result).not.toContain('app/a')
  })

  it('result is sorted alphabetically', () => {
    const g = buildDependencyGraph([
      makeEntry('app/z_consumer', ['app/base']),
      makeEntry('app/a_consumer', ['app/base']),
      makeEntry('app/m_consumer', ['app/base']),
      makeEntry('app/base'),
    ])
    const result = getImpactedCapabilities(g, 'app/base')
    expect(result).toEqual([
      'app/a_consumer',
      'app/m_consumer',
      'app/z_consumer',
    ])
  })

  it('isolated nodes not included in impact of unrelated capability', () => {
    const g = buildDependencyGraph([
      makeEntry('app/a'),
      makeEntry('app/b', ['app/a']),
      makeEntry('app/isolated'),
    ])
    const result = getImpactedCapabilities(g, 'app/a')
    expect(result).toEqual(['app/b'])
    expect(result).not.toContain('app/isolated')
  })
})