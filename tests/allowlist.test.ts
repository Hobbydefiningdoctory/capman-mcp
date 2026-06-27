import { describe, it, expect, vi, afterEach } from 'vitest'
import { validateAllowlist } from '../src/allowlist'
import type { Manifest } from 'capman'

function makeManifest(ids: string[]): Manifest {
  return {
    schemaVersion: '1.0',
    app: 'Test',
    description: '',
    capabilities: ids.map(id => ({
      id,
      name: id,
      description: 'test',
      privacy: { level: 'public' },
      lifecycle: { status: 'stable' },
      params: [],
      resolver: { type: 'api', endpoints: [] },
      examples: [],
    })),
  } as unknown as Manifest
}

describe('validateAllowlist', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not write warnings when all entries match built tools', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const manifest = makeManifest(['get_order'])
    validateAllowlist(
      [{ id: 'get_order' }],
      manifest,
      [{ name: 'get_order' }],
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('warns when allowlist entry is not in the manifest', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const manifest = makeManifest(['get_order'])
    validateAllowlist(
      [{ id: 'nonexistent' }],
      manifest,
      [],
    )
    const output = (spy.mock.calls[0][0] as string)
    expect(output).toMatch(/nonexistent/)
    expect(output).toMatch(/not found in manifest/)
  })

  it('warns when allowlist entry was filtered (non-public or deprecated)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const manifest = makeManifest(['get_order'])
    validateAllowlist(
      [{ id: 'get_order' }],
      manifest,
      [],
    )
    const output = (spy.mock.calls[0][0] as string)
    expect(output).toMatch(/get_order/)
    expect(output).toMatch(/filtered out/)
  })
})
