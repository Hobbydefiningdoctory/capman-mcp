/**
 * resolve.ts — Direct capability resolution, bypassing the BM25 matcher.
 *
 * When config.registryPath is set (registry mode), callTool() uses
 * resolveById() instead of engine.ask().  The MCP client already names the
 * tool explicitly, so BM25 matching is unnecessary overhead and a source of
 * occasional mis-matches.
 *
 * resolveById() looks up the capability in the capMap and calls
 * capman.resolve() directly with a synthetic MatchResult (confidence 100,
 * verdict 'clear'), bypassing the matcher entirely.
 *
 * Config mode (no registryPath) continues to use engine.ask() so that
 * natural-language queries benefit from BM25 + LLM fallback matching.
 */

import { resolve } from 'capman'
import type { EngineResult, MatchResult } from 'capman'
import type { CapabilityWithOutput } from './types'

export interface ResolveByIdOptions {
  baseUrl?: string
  dryRun?: boolean
  headers?: Record<string, string>
  auth?: import('capman').AuthContext
}

/**
 * Resolve a capability by ID, constructing a synthetic MatchResult so
 * capman.resolve() can execute the API call without running BM25 first.
 *
 * Returns an EngineResult-compatible object:
 *   - verdict 'clear', margin 100 when the capability is found
 *   - verdict 'uncertain', resolution.success false when ID is not in capMap
 */
export async function resolveById(
  id: string,
  params: Record<string, unknown>,
  capMap: Map<string, CapabilityWithOutput>,
  options: ResolveByIdOptions = {},
): Promise<EngineResult> {
  const capability = capMap.get(id)

  if (!capability) {
    return {
      match: {
        capability: null,
        confidence: 0,
        intent: 'retrieval',
        extractedParams: {},
        reasoning: `resolveById: capability "${id}" not found in capMap`,
        candidates: [],
      },
      resolution: {
        success: false,
        resolverType: null,
        error: `Capability "${id}" not found`,
      },
      resolvedVia: 'keyword',
      durationMs: 0,
      verdict: 'uncertain',
      margin: 0,
      trace: {
        query: id,
        candidates: [],
        reasoning: [`resolveById: capability "${id}" not found`],
        steps: [],
        resolvedVia: 'keyword',
        totalMs: 0,
      },
    } as unknown as EngineResult
  }

  // MatchResult.extractedParams is Record<string, string | null> — coerce
  const extractedParams: Record<string, string | null> = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, v != null ? String(v) : null]),
  )

  const matchResult: MatchResult = {
    capability,
    confidence: 100,
    intent: 'retrieval',
    extractedParams,
    reasoning: 'Direct resolve by ID — BM25 bypassed',
    candidates: [{ capabilityId: id, score: 100, matched: true }],
  }

  const startMs = Date.now()
  const resolution = await resolve(matchResult, params, {
    baseUrl: options.baseUrl,
    dryRun: options.dryRun,
    headers: options.headers,
    auth:    options.auth,
  })
  const durationMs = Date.now() - startMs

  return {
    match: matchResult,
    resolution,
    resolvedVia: 'keyword',
    durationMs,
    verdict: 'clear',
    margin: 100,
    trace: {
      query: id,
      candidates: [{ capabilityId: id, score: 100, matched: true }],
      reasoning: [`resolveById: direct resolve for "${id}"`],
      steps: [{ type: 'resolve', status: resolution.success ? 'pass' : 'fail', durationMs }],
      resolvedVia: 'keyword',
      totalMs: durationMs,
    },
  } as unknown as EngineResult
}
