/**
 * catalog.test.ts — Integration tests for the catalog HTTP service.
 *
 * Starts a real catalog server on a random available port, hits each
 * endpoint with Node's built-in http module, and asserts on status codes,
 * Content-Type headers, and response bodies.
 *
 * A temporary registry JSON file is written to the OS temp directory and
 * cleaned up after each describe block.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startCatalog } from '../src/catalog'
import type { RegistryEntry } from '../src/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(
  server: http.Server,
  urlPath: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const addr = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${addr.port}${urlPath}`,
      res => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () =>
          resolve({
            status:  res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body,
          }),
        )
      },
    )
    req.on('error', reject)
  })
}

async function getJson<T = unknown>(
  server: http.Server,
  urlPath: string,
): Promise<{ status: number; data: T }> {
  const { status, body } = await get(server, urlPath)
  return { status, data: JSON.parse(body) as T }
}

function makeEntry(overrides: Partial<RegistryEntry> & { fullyQualifiedId: string }): RegistryEntry {
  return {
    schemaVersion:  '1.0.0',
    owner:          'team-a',
    status:         'stable',
    schemaHash:     `hash-${overrides.fullyQualifiedId}`,
    approvedForMcp: true,
    riskLevel:      'low',
    publishedAt:    '2026-01-01T00:00:00.000Z',
    dependsOn:      [],
    ...overrides,
  }
}

function writeTempRegistry(entries: RegistryEntry[]): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'capman-catalog-test-'))
  const file = path.join(dir, 'registry.json')
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  return file
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_ENTRIES: RegistryEntry[] = [
  makeEntry({ fullyQualifiedId: 'my-shop/get_order',       riskLevel: 'low',    owner: 'team-a' }),
  makeEntry({ fullyQualifiedId: 'my-shop/list_products',   riskLevel: 'low',    owner: 'team-a' }),
  makeEntry({ fullyQualifiedId: 'my-shop/delete_account',  riskLevel: 'high',   owner: 'team-b', approvedForMcp: false }),
  makeEntry({ fullyQualifiedId: 'my-shop/create_payment',  riskLevel: 'high',   owner: 'team-b', approvedForMcp: true }),
  makeEntry({
    fullyQualifiedId: 'my-shop/order_summary',
    riskLevel: 'medium',
    owner: 'team-a',
    status: 'deprecated',
    approvedForMcp: false,
    dependsOn: ['my-shop/get_order'],
  }),
]

// ── Test suite ────────────────────────────────────────────────────────────────

describe('catalog HTTP service', () => {
  let server: http.Server
  let registryPath: string

  beforeAll(async () => {
    registryPath = writeTempRegistry(TEST_ENTRIES)
    // port 0 → OS assigns a random available port
    server = await startCatalog(0, { registryPath })
  })

  afterAll(() => {
    server.close()
    fs.rmSync(path.dirname(registryPath), { recursive: true, force: true })
  })

  // ── GET /health ─────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with ok: true and correct count', async () => {
      const { status, data } = await getJson<{ ok: boolean; count: number }>(server, '/health')
      expect(status).toBe(200)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(TEST_ENTRIES.length)
    })
  })

  // ── GET /capabilities ───────────────────────────────────────────────────────

  describe('GET /capabilities', () => {
    it('returns 200 with all entries when no filters', async () => {
      const { status, data } = await getJson<RegistryEntry[]>(server, '/capabilities')
      expect(status).toBe(200)
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBe(TEST_ENTRIES.length)
    })

    it('?q= filters by fullyQualifiedId substring (case-insensitive)', async () => {
      const { status, data } = await getJson<RegistryEntry[]>(server, '/capabilities?q=order')
      expect(status).toBe(200)
      // get_order and order_summary both contain 'order'
      expect(data.every(e => e.fullyQualifiedId.toLowerCase().includes('order'))).toBe(true)
      expect(data.length).toBeGreaterThanOrEqual(2)
    })

    it('?q= filters by owner substring', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?q=team-b')
      expect(data.every(e => e.owner === 'team-b')).toBe(true)
      expect(data.length).toBe(2)
    })

    it('?risk=high returns only high-risk entries', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?risk=high')
      expect(data.every(e => e.riskLevel === 'high')).toBe(true)
      expect(data.length).toBe(2)
    })

    it('?risk=low returns only low-risk entries', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?risk=low')
      expect(data.every(e => e.riskLevel === 'low')).toBe(true)
    })

    it('?status=deprecated returns only deprecated entries', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?status=deprecated')
      expect(data.every(e => e.status === 'deprecated')).toBe(true)
      expect(data.length).toBe(1)
      expect(data[0].fullyQualifiedId).toBe('my-shop/order_summary')
    })

    it('?approvedForMcp=false returns unapproved entries', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?approvedForMcp=false')
      expect(data.every(e => e.approvedForMcp === false)).toBe(true)
      expect(data.length).toBe(2)
    })

    it('?approvedForMcp=true returns approved entries only', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?approvedForMcp=true')
      expect(data.every(e => e.approvedForMcp === true)).toBe(true)
    })

    it('combined filters: ?risk=high&approvedForMcp=true', async () => {
      const { data } = await getJson<RegistryEntry[]>(server, '/capabilities?risk=high&approvedForMcp=true')
      expect(data.every(e => e.riskLevel === 'high' && e.approvedForMcp)).toBe(true)
      expect(data.length).toBe(1)
      expect(data[0].fullyQualifiedId).toBe('my-shop/create_payment')
    })

    it('?q= with no matches returns empty array', async () => {
      const { status, data } = await getJson<RegistryEntry[]>(server, '/capabilities?q=xyznotexist')
      expect(status).toBe(200)
      expect(data).toEqual([])
    })
  })

  // ── GET /capabilities/:fqId ─────────────────────────────────────────────────

  describe('GET /capabilities/:fqId', () => {
    it('returns 200 with the correct entry for a known fqId', async () => {
      const { status, data } = await getJson<RegistryEntry>(
        server, '/capabilities/my-shop/get_order',
      )
      expect(status).toBe(200)
      expect(data.fullyQualifiedId).toBe('my-shop/get_order')
      expect(data.riskLevel).toBe('low')
    })

    it('returns 404 for an unknown fqId', async () => {
      const { status } = await getJson(server, '/capabilities/my-shop/does_not_exist')
      expect(status).toBe(404)
    })

    it('returns 404 for a partially matching fqId', async () => {
      const { status } = await getJson(server, '/capabilities/my-shop')
      expect(status).toBe(404)
    })
  })

  // ── GET /capabilities/:fqId/badge ──────────────────────────────────────────

  describe('GET /capabilities/:fqId/badge', () => {
    it('returns 200 with Content-Type image/svg+xml', async () => {
      const { status, headers } = await get(server, '/capabilities/my-shop/get_order/badge')
      expect(status).toBe(200)
      expect(headers['content-type']).toContain('image/svg+xml')
    })

    it('approved low-risk badge contains "approved" text', async () => {
      const { body } = await get(server, '/capabilities/my-shop/get_order/badge')
      expect(body).toContain('approved')
      expect(body).toContain('<svg')
    })

    it('approved high-risk badge contains "high risk" text', async () => {
      const { body } = await get(server, '/capabilities/my-shop/create_payment/badge')
      expect(body).toContain('high risk')
    })

    it('unapproved entry badge contains "blocked" text', async () => {
      const { body } = await get(server, '/capabilities/my-shop/delete_account/badge')
      expect(body).toContain('blocked')
    })

    it('returns 404 for unknown fqId', async () => {
      const { status } = await get(server, '/capabilities/my-shop/unknown/badge')
      expect(status).toBe(404)
    })
  })

  // ── GET /capabilities/:fqId/impact ─────────────────────────────────────────

  describe('GET /capabilities/:fqId/impact', () => {
    it('returns 200 with impacted array for a known dependency', async () => {
      const { status, data } = await getJson<{ fullyQualifiedId: string; impacted: string[] }>(
        server, '/capabilities/my-shop/get_order/impact',
      )
      expect(status).toBe(200)
      expect(data.fullyQualifiedId).toBe('my-shop/get_order')
      // order_summary depends on get_order
      expect(data.impacted).toContain('my-shop/order_summary')
    })

    it('returns empty impacted array for a capability with no dependents', async () => {
      const { status, data } = await getJson<{ impacted: string[] }>(
        server, '/capabilities/my-shop/list_products/impact',
      )
      expect(status).toBe(200)
      expect(data.impacted).toEqual([])
    })

    it('returns 404 for unknown fqId', async () => {
      const { status } = await getJson(server, '/capabilities/my-shop/unknown/impact')
      expect(status).toBe(404)
    })
  })

  // ── Unknown paths ───────────────────────────────────────────────────────────

  describe('unknown paths', () => {
    it('GET /unknown-path returns 404', async () => {
      const { status } = await getJson(server, '/unknown-path')
      expect(status).toBe(404)
    })

    it('GET / returns 404', async () => {
      const { status } = await getJson(server, '/')
      expect(status).toBe(404)
    })
  })
})

// ── Empty registry ────────────────────────────────────────────────────────────

describe('catalog with empty registry', () => {
  let server: http.Server
  let registryPath: string

  beforeAll(async () => {
    registryPath = writeTempRegistry([])
    server = await startCatalog(0, { registryPath })
  })

  afterAll(() => {
    server.close()
    fs.rmSync(path.dirname(registryPath), { recursive: true, force: true })
  })

  it('GET /health returns count: 0', async () => {
    const { data } = await getJson<{ ok: boolean; count: number }>(server, '/health')
    expect(data.count).toBe(0)
  })

  it('GET /capabilities returns empty array', async () => {
    const { status, data } = await getJson<RegistryEntry[]>(server, '/capabilities')
    expect(status).toBe(200)
    expect(data).toEqual([])
  })
})