/**
 * risk.ts — Capability risk level derivation for Phase 3 Policy and Risk.
 *
 * Computes a RiskLevel from a capability's HTTP methods, privacy scope, and
 * declared error codes.  Pure function — no side effects, no imports from
 * other capman-mcp modules.  Called by publishManifest() on every
 * create/update and by buildToolList() for the policy gate filter.
 *
 * Derivation rules (first match wins, top to bottom):
 *
 *   Rule 1 — admin privacy                              → high
 *   Rule 2 — financial error code present               → high
 *   Rule 3 — mutating method (POST/PUT/PATCH/DELETE)    → medium (floor)
 *   Rule 4 — any method + user_owned privacy            → medium
 *   Rule 5 — GET/HEAD/OPTIONS + public + no financial   → low
 *
 * For hybrid resolvers the API endpoints are inspected; nav-only resolvers
 * have no HTTP method and are treated as GET-equivalent.
 */

import type { Capability, HttpMethod } from 'capman'

// ── Public types ──────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high'

// ── Constants ─────────────────────────────────────────────────────────────────

const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

/**
 * Substrings matched case-insensitively against CapabilityError.code.
 * Any match escalates riskLevel to 'high'.
 */
const FINANCIAL_KEYWORDS: readonly string[] = [
  'payment',
  'charge',
  'billing',
  'financial',
  'refund',
  'invoice',
  'subscription',
]

// ── Internal helpers ──────────────────────────────────────────────────────────

function hasFinancialError(capability: Capability): boolean {
  if (!capability.errors?.length) return false
  return capability.errors.some(err =>
    FINANCIAL_KEYWORDS.some(kw => err.code.toLowerCase().includes(kw)),
  )
}

function extractMethods(capability: Capability): HttpMethod[] {
  const r = capability.resolver
  if (r.type === 'api')    return r.endpoints.map(e => e.method)
  if (r.type === 'hybrid') return r.api.endpoints.map(e => e.method)
  return [] // nav-only — no HTTP method, treated as GET-equivalent
}

function hasMutatingMethod(capability: Capability): boolean {
  return extractMethods(capability).some(m => MUTATING_METHODS.has(m))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive the risk level for a single capability.
 *
 * @example
 * deriveRiskLevel(getProductsCap)   // → 'low'   (GET + public)
 * deriveRiskLevel(deleteOrderCap)   // → 'medium' (DELETE + public)
 * deriveRiskLevel(createPaymentCap) // → 'high'  (financial error codes)
 * deriveRiskLevel(listAdminCap)     // → 'high'  (admin privacy)
 */
export function deriveRiskLevel(capability: Capability): RiskLevel {
  const privacy   = capability.privacy.level
  const financial = hasFinancialError(capability)
  const mutating  = hasMutatingMethod(capability)

  if (privacy === 'admin') return 'high'    // Rule 1
  if (financial)           return 'high'    // Rule 2
  if (mutating)            return 'medium'  // Rule 3
  if (privacy === 'user_owned') return 'medium' // Rule 4
  return 'low'                              // Rule 5
}

/**
 * Return the higher of two risk levels.
 *
 * @example
 * maxRisk('low', 'medium') // → 'medium'
 * maxRisk('high', 'low')   // → 'high'
 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
  return order[a] >= order[b] ? a : b
}