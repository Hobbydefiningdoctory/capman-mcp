import { describe, it, expect } from 'vitest'
import { buildToolList } from '../src/bridge'
import type { Manifest } from 'capman'
import type { CapmanMcpConfig, RegistryEntry } from '../src/types'

function makeManifest(overrides: Partial<Manifest['capabilities'][number]>[] = []): Manifest {
  const base = {
    id: 'get_order',
    name: 'Get Order',
    description: 'Retrieve an order by ID',
    privacy: { level: 'public' as const },
    lifecycle: { status: 'stable' as const },
    params: [
      { name: 'order_id', description: 'Order ID', required: true, source: 'user_query' as const },
    ],
    resolver: { type: 'api' as const, endpoints: [{ method: 'GET' as const, path: '/orders/{order_id}' }] },
    examples: ['get order ORD-123'],
  }
  return {
    schemaVersion: '1.0',
    app: 'Test',
    description: 'Test manifest',
    capabilities: overrides.map(o => ({ ...base, ...o })).concat(overrides.length === 0 ? [base] : []),
  } as unknown as Manifest
}

const baseConfig: CapmanMcpConfig = {
  manifest: 'manifest.json',
  allowedCapabilities: [{ id: 'get_order' }],
}

describe('buildToolList', () => {
  it('returns a tool for each approved public stable capability', () => {
    const manifest = makeManifest()
    const tools = buildToolList(manifest, baseConfig)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('get_order')
    expect(tools[0].description).toBe('Retrieve an order by ID')
  })

  it('applies descriptionOverride when set', () => {
    const manifest = makeManifest()
    const config: CapmanMcpConfig = {
      ...baseConfig,
      allowedCapabilities: [{ id: 'get_order', descriptionOverride: 'Custom description' }],
    }
    const tools = buildToolList(manifest, config)
    expect(tools[0].description).toBe('Custom description')
  })

  it('excludes capabilities not in the allowlist', () => {
    const manifest = makeManifest([{ id: 'get_order' }, { id: 'list_orders' }] as never)
    const manifest2: Manifest = {
      ...manifest,
      capabilities: [
        { id: 'get_order', name: 'Get Order', description: 'A', privacy: { level: 'public' }, lifecycle: { status: 'stable' }, params: [], resolver: { type: 'api', endpoints: [] }, examples: [] },
        { id: 'list_orders', name: 'List Orders', description: 'B', privacy: { level: 'public' }, lifecycle: { status: 'stable' }, params: [], resolver: { type: 'api', endpoints: [] }, examples: [] },
      ] as unknown as Manifest['capabilities'],
    }
    const tools = buildToolList(manifest2, baseConfig)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('get_order')
  })

  it('excludes non-public capabilities', () => {
    const manifest: Manifest = {
      schemaVersion: '1.0',
      app: 'Test',
      description: '',
      capabilities: [
        { id: 'get_order', name: 'Get Order', description: 'A', privacy: { level: 'user_owned' }, lifecycle: { status: 'stable' }, params: [], resolver: { type: 'api', endpoints: [] }, examples: [] },
      ] as unknown as Manifest['capabilities'],
    }
    const tools = buildToolList(manifest, baseConfig)
    expect(tools).toHaveLength(0)
  })

  it('excludes deprecated capabilities', () => {
    const manifest: Manifest = {
      schemaVersion: '1.0',
      app: 'Test',
      description: '',
      capabilities: [
        { id: 'get_order', name: 'Get Order', description: 'A', privacy: { level: 'public' }, lifecycle: { status: 'deprecated' }, params: [], resolver: { type: 'api', endpoints: [] }, examples: [] },
      ] as unknown as Manifest['capabilities'],
    }
    const tools = buildToolList(manifest, baseConfig)
    expect(tools).toHaveLength(0)
  })

  it('produces correct inputSchema with required params', () => {
    const manifest = makeManifest()
    const tools = buildToolList(manifest, baseConfig)
    expect(tools[0].inputSchema.type).toBe('object')
    expect(tools[0].inputSchema.properties).toHaveProperty('order_id')
    expect(tools[0].inputSchema.required).toContain('order_id')
  })
})

// ── buildToolList — registry mode ─────────────────────────────────────────────

function makeRegistryManifest(): Manifest {
  return {
    schemaVersion: '1.0',
    app: 'My App',
    description: '',
    capabilities: [
      {
        id: 'get_order',
        name: 'Get Order',
        description: 'Retrieve an order',
        privacy: { level: 'public' },
        lifecycle: { status: 'stable' },
        params: [],
        resolver: { type: 'api', endpoints: [] },
        examples: [],
      },
      {
        id: 'list_products',
        name: 'List Products',
        description: 'List all products',
        privacy: { level: 'public' },
        lifecycle: { status: 'stable' },
        params: [],
        resolver: { type: 'api', endpoints: [] },
        examples: [],
      },
    ] as unknown as Manifest['capabilities'],
  }
}

function makeRegistryEntry(
  id: string,
  approvedForMcp: boolean,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    fullyQualifiedId: id,
    schemaVersion: '1.0',
    owner: 'team',
    status: 'stable',
    schemaHash: 'abc',
    approvedForMcp,
    publishedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('buildToolList with registry', () => {
  it('approves tools whose registry entry has approvedForMcp: true', () => {
    const manifest = makeRegistryManifest()
    const registry: RegistryEntry[] = [
      makeRegistryEntry('my-app/get_order', true),
      makeRegistryEntry('my-app/list_products', false),
    ]
    const tools = buildToolList(manifest, { manifest: 'm.json', allowedCapabilities: [] }, registry)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('get_order')
  })

  it('excludes tools whose registry entry has approvedForMcp: false', () => {
    const manifest = makeRegistryManifest()
    const registry: RegistryEntry[] = [
      makeRegistryEntry('my-app/get_order', false),
      makeRegistryEntry('my-app/list_products', false),
    ]
    const tools = buildToolList(manifest, { manifest: 'm.json', allowedCapabilities: [] }, registry)
    expect(tools).toHaveLength(0)
  })

  it('excludes tools absent from the registry entirely', () => {
    const manifest = makeRegistryManifest()
    const registry: RegistryEntry[] = [
      makeRegistryEntry('my-app/get_order', true),
      // list_products has no entry at all
    ]
    const tools = buildToolList(manifest, { manifest: 'm.json', allowedCapabilities: [] }, registry)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('get_order')
  })

  it('config descriptionOverride still applies in registry mode', () => {
    const manifest = makeRegistryManifest()
    const registry: RegistryEntry[] = [makeRegistryEntry('my-app/get_order', true)]
    const config: CapmanMcpConfig = {
      manifest: 'm.json',
      allowedCapabilities: [{ id: 'get_order', descriptionOverride: 'Custom override' }],
    }
    const tools = buildToolList(manifest, config, registry)
    expect(tools[0].description).toBe('Custom override')
  })

  it('registry-approved cap with no config entry uses the original description', () => {
    const manifest = makeRegistryManifest()
    const registry: RegistryEntry[] = [makeRegistryEntry('my-app/get_order', true)]
    const tools = buildToolList(manifest, { manifest: 'm.json', allowedCapabilities: [] }, registry)
    expect(tools[0].description).toBe('Retrieve an order')
  })
})
