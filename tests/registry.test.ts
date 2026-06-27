import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Capability, Manifest } from 'capman'
import {
  computeSchemaHash,
  deprecateCapability,
  diffManifestVsRegistry,
  listRegistry,
  loadRegistry,
  publishManifest,
  saveRegistry,
  toAppSlug,
  toFullyQualifiedId,
} from '../src/registry'
import type { RegistryEntry } from '../src/types'

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpFiles: string[] = []

function tempPath(): string {
  const p = path.join(
    os.tmpdir(),
    `capman-mcp-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f)
    } catch {
      // already gone
    }
  }
  tmpFiles.length = 0
})

function makeCap(id: string, overrides: Partial<Capability> = {}): Capability {
  return {
    id,
    name: id,
    description: `Cap ${id}`,
    params: [],
    resolver: { type: 'api', endpoints: [] },
    privacy: { level: 'public' },
    lifecycle: { status: 'stable' },
    examples: [],
    ...overrides,
  } as unknown as Capability
}

function makeManifest(app: string, caps: Capability[]): Manifest {
  return {
    schemaVersion: '1.0',
    app,
    description: '',
    capabilities: caps,
  } as unknown as Manifest
}

// ── toAppSlug ─────────────────────────────────────────────────────────────────

describe('toAppSlug', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(toAppSlug('My App')).toBe('my-app')
  })

  it('collapses consecutive non-alphanumeric chars into a single dash', () => {
    expect(toAppSlug('My--App!')).toBe('my-app')
  })

  it('removes leading and trailing dashes', () => {
    expect(toAppSlug('  My App  ')).toBe('my-app')
  })

  it('returns a clean lowercase slug unchanged', () => {
    expect(toAppSlug('shopify')).toBe('shopify')
  })
})

// ── toFullyQualifiedId ────────────────────────────────────────────────────────

describe('toFullyQualifiedId', () => {
  it('formats as appSlug/capabilityId', () => {
    expect(toFullyQualifiedId('My App', 'get_order')).toBe('my-app/get_order')
  })

  it('keeps capability id as-is', () => {
    expect(toFullyQualifiedId('Acme Corp', 'list_products_v2')).toBe('acme-corp/list_products_v2')
  })
})

// ── computeSchemaHash ─────────────────────────────────────────────────────────

describe('computeSchemaHash', () => {
  it('returns a 64-char lowercase hex string', () => {
    expect(computeSchemaHash(makeCap('get_order'))).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic for the same capability', () => {
    const cap = makeCap('get_order')
    expect(computeSchemaHash(cap)).toBe(computeSchemaHash(cap))
  })

  it('differs when capability definition changes', () => {
    const cap1 = makeCap('get_order')
    const cap2 = makeCap('get_order', { description: 'Different' })
    expect(computeSchemaHash(cap1)).not.toBe(computeSchemaHash(cap2))
  })
})

// ── loadRegistry ──────────────────────────────────────────────────────────────

describe('loadRegistry', () => {
  it('returns empty array for a missing file', () => {
    expect(loadRegistry('/tmp/capman-mcp-nonexistent-99999.json')).toEqual([])
  })
})

// ── saveRegistry + loadRegistry round-trip ────────────────────────────────────

describe('saveRegistry + loadRegistry', () => {
  it('round-trips entries to disk', () => {
    const p = tempPath()
    const entry: RegistryEntry = {
      fullyQualifiedId: 'my-app/get_order',
      schemaVersion: '1.0',
      owner: 'team-a',
      status: 'stable',
      schemaHash: 'abc123',
      approvedForMcp: true,
      publishedAt: '2026-01-01T00:00:00.000Z',
    }
    saveRegistry([entry], p)
    // loadRegistry backfills riskLevel: 'medium' (Phase 3) and dependsOn: []
    // (Phase 4) for old entries saved without these fields. The round-trip is
    // lossy by design — old entries gain safe defaults on first load.
    expect(loadRegistry(p)).toEqual([{ ...entry, riskLevel: 'medium', dependsOn: [] }])
  })
})

// ── publishManifest ───────────────────────────────────────────────────────────

describe('publishManifest', () => {
  it('creates entries for all capabilities in the manifest', () => {
    const p = tempPath()
    const manifest = makeManifest('Test App', [makeCap('get_order'), makeCap('list_products')])
    const result = publishManifest(manifest, { registryPath: p })

    expect(result.created).toContain('test-app/get_order')
    expect(result.created).toContain('test-app/list_products')
    expect(result.updated).toHaveLength(0)
    expect(result.unchanged).toHaveLength(0)

    const entries = loadRegistry(p)
    expect(entries).toHaveLength(2)
  })

  it('sets approvedForMcp: true by default', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })
    expect(loadRegistry(p)[0].approvedForMcp).toBe(true)
  })

  it('respects approvedForMcp: false option', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), {
      registryPath: p,
      approvedForMcp: false,
    })
    expect(loadRegistry(p)[0].approvedForMcp).toBe(false)
  })

  it('stores the owner from options', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), {
      registryPath: p,
      owner: 'team-commerce',
    })
    expect(loadRegistry(p)[0].owner).toBe('team-commerce')
  })

  it('marks existing entry as updated when schema hash changes', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })

    const result = publishManifest(
      makeManifest('Test App', [makeCap('get_order', { description: 'Changed!' })]),
      { registryPath: p },
    )
    expect(result.updated).toContain('test-app/get_order')
    expect(result.created).toHaveLength(0)
    expect(result.unchanged).toHaveLength(0)
  })

  it('marks existing entry as unchanged when schema hash matches', () => {
    const p = tempPath()
    const manifest = makeManifest('Test App', [makeCap('get_order')])
    publishManifest(manifest, { registryPath: p })
    const result = publishManifest(manifest, { registryPath: p })

    expect(result.unchanged).toContain('test-app/get_order')
    expect(result.updated).toHaveLength(0)
    expect(result.created).toHaveLength(0)
  })

  it('derives lifecycle status from capability', () => {
    const p = tempPath()
    publishManifest(
      makeManifest('Test App', [
        makeCap('beta_op', { lifecycle: { status: 'experimental' } as never }),
      ]),
      { registryPath: p },
    )
    expect(loadRegistry(p)[0].status).toBe('experimental')
  })

  it('uses correct fullyQualifiedId derived from app name', () => {
    const p = tempPath()
    publishManifest(makeManifest('Acme Corp', [makeCap('search')]), { registryPath: p })
    expect(loadRegistry(p)[0].fullyQualifiedId).toBe('acme-corp/search')
  })
})

// ── deprecateCapability ───────────────────────────────────────────────────────

describe('deprecateCapability', () => {
  it('sets status deprecated, approvedForMcp false, and records deprecatedAt', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })

    const entry = deprecateCapability('test-app/get_order', { registryPath: p })
    expect(entry.status).toBe('deprecated')
    expect(entry.approvedForMcp).toBe(false)
    expect(entry.deprecatedAt).toBeTruthy()
  })

  it('stores successor when provided', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })

    const entry = deprecateCapability('test-app/get_order', {
      registryPath: p,
      successor: 'test-app/get_order_v2',
    })
    expect(entry.successor).toBe('test-app/get_order_v2')
  })

  it('throws when fullyQualifiedId is not found', () => {
    const p = tempPath()
    expect(() =>
      deprecateCapability('test-app/nonexistent', { registryPath: p }),
    ).toThrow(/not found/)
  })

  it('persists changes to disk', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })
    deprecateCapability('test-app/get_order', { registryPath: p })

    const entries = loadRegistry(p)
    expect(entries[0].status).toBe('deprecated')
    expect(entries[0].approvedForMcp).toBe(false)
    expect(entries[0].deprecatedAt).toBeTruthy()
  })
})

// ── listRegistry ──────────────────────────────────────────────────────────────

describe('listRegistry', () => {
  it('returns all entries when no filter', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('a'), makeCap('b')]), { registryPath: p })
    expect(listRegistry({ registryPath: p })).toHaveLength(2)
  })

  it('filters by appSlug', () => {
    const p = tempPath()
    publishManifest(makeManifest('App A', [makeCap('op_a')]), { registryPath: p })
    publishManifest(makeManifest('App B', [makeCap('op_b')]), { registryPath: p })

    const entries = listRegistry({ appSlug: 'app-a', registryPath: p })
    expect(entries).toHaveLength(1)
    expect(entries[0].fullyQualifiedId).toBe('app-a/op_a')
  })

  it('returns empty array for an empty registry', () => {
    const p = tempPath()
    expect(listRegistry({ registryPath: p })).toHaveLength(0)
  })
})

// ── diffManifestVsRegistry ────────────────────────────────────────────────────

describe('diffManifestVsRegistry', () => {
  it('marks all capabilities as new when registry is empty', () => {
    const p = tempPath()
    const manifest = makeManifest('Test App', [makeCap('get_order')])
    const diffs = diffManifestVsRegistry(manifest, { registryPath: p })

    expect(diffs).toHaveLength(1)
    expect(diffs[0].status).toBe('new')
    expect(diffs[0].fullyQualifiedId).toBe('test-app/get_order')
    expect(diffs[0].currentHash).toBeTruthy()
  })

  it('marks capability as unchanged when hash matches', () => {
    const p = tempPath()
    const manifest = makeManifest('Test App', [makeCap('get_order')])
    publishManifest(manifest, { registryPath: p })

    const diffs = diffManifestVsRegistry(manifest, { registryPath: p })
    expect(diffs[0].status).toBe('unchanged')
  })

  it('marks capability as changed when schema hash differs', () => {
    const p = tempPath()
    publishManifest(makeManifest('Test App', [makeCap('get_order')]), { registryPath: p })

    const changedManifest = makeManifest('Test App', [
      makeCap('get_order', { description: 'Updated description' }),
    ])
    const diffs = diffManifestVsRegistry(changedManifest, { registryPath: p })

    expect(diffs[0].status).toBe('changed')
    expect(diffs[0].previousHash).toBeDefined()
    expect(diffs[0].currentHash).toBeDefined()
    expect(diffs[0].previousHash).not.toBe(diffs[0].currentHash)
  })

  it('marks capability as removed when it is in registry but not manifest', () => {
    const p = tempPath()
    publishManifest(
      makeManifest('Test App', [makeCap('get_order'), makeCap('list_products')]),
      { registryPath: p },
    )

    const reducedManifest = makeManifest('Test App', [makeCap('get_order')])
    const diffs = diffManifestVsRegistry(reducedManifest, { registryPath: p })

    const removed = diffs.find(d => d.fullyQualifiedId === 'test-app/list_products')
    expect(removed?.status).toBe('removed')
    expect(removed?.previousHash).toBeTruthy()
  })

  it('only diffs capabilities belonging to the manifest app', () => {
    const p = tempPath()
    publishManifest(makeManifest('Other App', [makeCap('other_op')]), { registryPath: p })

    const manifest = makeManifest('Test App', [makeCap('get_order')])
    const diffs = diffManifestVsRegistry(manifest, { registryPath: p })

    expect(diffs).toHaveLength(1)
    expect(diffs[0].status).toBe('new')
    expect(diffs[0].fullyQualifiedId).toBe('test-app/get_order')
  })
})
