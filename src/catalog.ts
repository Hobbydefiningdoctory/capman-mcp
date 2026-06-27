/**
 * catalog.ts — Read-only HTTP catalog service for capability discovery.
 *
 * Exposes the capability registry as a queryable HTTP API with full-text
 * search, filters, and an MCP compatibility badge endpoint.
 *
 * Uses Node.js built-in `http` only — zero additional runtime dependencies.
 *
 * Endpoints:
 *   GET /health                          → { ok: true, count: N }
 *   GET /capabilities                    → RegistryEntry[] (filtered)
 *   GET /capabilities/:fqId             → RegistryEntry | 404
 *   GET /capabilities/:fqId/badge       → SVG badge (MCP compatibility)
 *   GET /capabilities/:fqId/impact      → string[] (impacted fqIds)
 *   All other paths                      → 404
 *
 * Query params for GET /capabilities:
 *   ?q=<text>               Substring match on fullyQualifiedId and owner
 *   ?risk=<low|medium|high> Filter by riskLevel
 *   ?status=<stable|...>    Filter by lifecycle status
 *   ?approvedForMcp=<bool>  Filter by approvedForMcp
 *
 * The registry is re-loaded from disk on every request — no in-memory cache.
 * This ensures the catalog always reflects current state without a restart.
 */

import * as http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { loadRegistry } from './registry'
import { buildDependencyGraph, getImpactedCapabilities } from './graph'
import type { RegistryEntry } from './types'

// ── Public API ────────────────────────────────────────────────────────────────

export interface CatalogOptions {
  /** Path to the registry JSON file. Defaults to ~/.capman-mcp/registry.json */
  registryPath?: string
  /**
   * Optional: path to the capman manifest JSON.
   * When provided, tag and description data from the manifest enriches the
   * catalog response. Without it, only registry data is served.
   */
  manifestPath?: string
}

/**
 * Start the read-only catalog HTTP server.
 *
 * @param port    - TCP port to listen on.
 * @param options - Registry path and optional manifest path.
 * @returns The Node.js http.Server instance (already listening).
 *          Call server.close() to shut it down.
 *
 * @example
 * const server = await startCatalog(4001, { registryPath: '.capman-mcp/registry.json' })
 * // later:
 * server.close()
 */
export function startCatalog(
  port: number,
  options: CatalogOptions = {},
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, options).catch(err => {
        sendJson(res, 500, { error: 'Internal server error', detail: String(err) })
      })
    })

    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(
  req:  IncomingMessage,
  res:  ServerResponse,
  opts: CatalogOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' })
    return
  }

  const url     = new URL(req.url ?? '/', `http://localhost`)
  const parts   = url.pathname.split('/').filter(Boolean)
  // parts[0] === 'capabilities' or 'health'

  // GET /health
  if (parts.length === 1 && parts[0] === 'health') {
    const entries = loadRegistry(opts.registryPath)
    sendJson(res, 200, { ok: true, count: entries.length })
    return
  }

  // GET /capabilities[?filters]
  if (parts.length === 1 && parts[0] === 'capabilities') {
    const entries = loadRegistry(opts.registryPath)
    const filtered = applyFilters(entries, url.searchParams)
    sendJson(res, 200, filtered)
    return
  }

  // /capabilities/:fqId[/badge|/impact]
  if (parts.length >= 2 && parts[0] === 'capabilities') {
    // The fqId contains a slash: "app-slug/capability-id"
    // parts[1] = "app-slug", parts[2] = "capability-id" or sub-resource
    // sub-resource is the last part when parts.length >= 4
    const isBadge  = parts[parts.length - 1] === 'badge'
    const isImpact = parts[parts.length - 1] === 'impact'

    let fqId: string
    if (isBadge || isImpact) {
      // Reconstruct fqId from everything except the last segment
      fqId = parts.slice(1, -1).join('/')
    } else {
      fqId = parts.slice(1).join('/')
    }

    const entries = loadRegistry(opts.registryPath)
    const entry   = entries.find(e => e.fullyQualifiedId === fqId)

    if (!entry) {
      sendJson(res, 404, { error: `Capability "${fqId}" not found` })
      return
    }

    // GET /capabilities/:fqId/badge
    if (isBadge) {
      const svg = buildBadge(entry)
      res.writeHead(200, {
        'Content-Type':  'image/svg+xml',
        'Cache-Control': 'no-cache',
      })
      res.end(svg)
      return
    }

    // GET /capabilities/:fqId/impact
    if (isImpact) {
      const graph   = buildDependencyGraph(entries)
      const impacted = getImpactedCapabilities(graph, fqId)
      sendJson(res, 200, { fullyQualifiedId: fqId, impacted })
      return
    }

    // GET /capabilities/:fqId
    sendJson(res, 200, entry)
    return
  }

  sendJson(res, 404, { error: 'Not Found' })
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function applyFilters(
  entries: RegistryEntry[],
  params:  URLSearchParams,
): RegistryEntry[] {
  let result = entries

  // ?q= — substring match on fullyQualifiedId and owner (case-insensitive)
  const q = params.get('q')?.toLowerCase()
  if (q) {
    result = result.filter(e =>
      e.fullyQualifiedId.toLowerCase().includes(q) ||
      (e.owner ?? '').toLowerCase().includes(q),
    )
  }

  // ?risk=low|medium|high
  const risk = params.get('risk')
  if (risk) {
    result = result.filter(e => e.riskLevel === risk)
  }

  // ?status=stable|beta|experimental|deprecated
  const status = params.get('status')
  if (status) {
    result = result.filter(e => e.status === status)
  }

  // ?approvedForMcp=true|false
  const approved = params.get('approvedForMcp')
  if (approved !== null) {
    const wantApproved = approved.toLowerCase() !== 'false'
    result = result.filter(e => e.approvedForMcp === wantApproved)
  }

  return result
}

// ── Badge SVG ─────────────────────────────────────────────────────────────────

/**
 * Build a shields.io-style SVG badge for a registry entry.
 *
 * Colour semantics:
 *   green  (#4c1) — approvedForMcp: true, riskLevel: low or medium
 *   amber  (#e78) — approvedForMcp: true, riskLevel: high (needs review)
 *   red    (#e05) — approvedForMcp: false or riskOverride: 'block'
 */
function buildBadge(entry: RegistryEntry): string {
  const blocked  = !entry.approvedForMcp || entry.riskOverride === 'block'
  const highRisk = entry.riskLevel === 'high' && !blocked

  const label  = 'MCP'
  const value  = blocked ? 'blocked' : highRisk ? 'high risk' : 'approved'
  const color  = blocked ? '#e05252' : highRisk ? '#e7a234' : '#44cc11'

  // Label and value text widths (approximate, monospace-based)
  const lw = label.length * 6 + 10   // label pill width
  const vw = value.length * 6 + 10   // value pill width
  const tw = lw + vw                  // total width

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20">`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`,
    `    <stop offset="1" stop-opacity=".1"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r">`,
    `    <rect width="${tw}" height="20" rx="3" fill="#fff"/>`,
    `  </clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${lw}" height="20" fill="#555"/>`,
    `    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>`,
    `    <rect width="${tw}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">`,
    `    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>`,
    `    <text x="${lw / 2}" y="14">${label}</text>`,
    `    <text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>`,
    `    <text x="${lw + vw / 2}" y="14">${value}</text>`,
    `  </g>`,
    `</svg>`,
  ].join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-cache',
  })
  res.end(payload)
}