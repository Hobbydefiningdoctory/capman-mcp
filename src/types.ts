import type { Capability, LifecycleStatus } from 'capman'
import type { RiskLevel } from './risk'

export type CapabilityOutputPropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null'

export interface CapabilityOutputProperty {
  type: CapabilityOutputPropertyType
  description?: string
  format?: string
  items?: CapabilityOutputProperty
  properties?: Record<string, CapabilityOutputProperty>
  required?: string[]
  enum?: (string | number | boolean)[]
}

export interface CapabilityOutputSchema {
  type: 'object'
  properties: Record<string, CapabilityOutputProperty>
  required?: string[]
  description?: string
}

export type CapabilityWithOutput = Capability & {
  outputSchema?: CapabilityOutputSchema
}

export interface AllowedCapabilityEntry {
  id: string
  descriptionOverride?: string
  dryRunOverride?: boolean
  /**
   * Explicitly allow a high-risk capability to be exposed as an MCP tool.
   * Required when policyGate is true (default) and riskLevel is 'high'.
   */
  allowHighRisk?: boolean
}

/**
 * Auth context for the server instance.
 *
 * When set, user_owned capabilities are allowed through the privacy filter
 * and capman injects auth.userId into params marked source: 'session' before
 * making the API call. The agent never sees the userId — it is excluded from
 * the MCP input schema by schema-derive.ts.
 *
 * This is a static, server-level identity. Every tool call on this server
 * instance runs as the same user. Suitable for personal Claude Desktop setups
 * and single-user deployments.
 *
 * admin capabilities remain hard-blocked regardless of this field.
 */
export interface CapmanMcpAuthConfig {
  isAuthenticated: boolean
  userId?: string
  role?: 'user' | 'admin'
}

export interface CapmanMcpConfig {
  manifest: string
  baseUrl?: string
  mode?: 'cheap' | 'balanced' | 'accurate'
  dryRun?: boolean
  transport?: 'stdio' | 'http'
  httpPort?: number
  allowedCapabilities: AllowedCapabilityEntry[]
  registryPath?: string
  policyGate?: boolean
  auth?: CapmanMcpAuthConfig
  audit?: {
    enabled: boolean
    logFile?: string
  }
}

// ── Policy and risk ───────────────────────────────────────────────────────────

export type { RiskLevel } from './risk'

// ── Registry ──────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  /** "{appSlug}/{capabilityId}" — e.g. "my-shop/get_order" */
  fullyQualifiedId: string
  schemaVersion:    string
  owner:            string
  status:           LifecycleStatus
  /** SHA-256 of JSON.stringify(capability) */
  schemaHash:       string
  approvedForMcp:   boolean
  /** Derived automatically on publish from HTTP method + privacy + error codes */
  riskLevel?:       RiskLevel
  /**
   * Explicit operator override.
   * 'allow' — expose despite high risk (operator has reviewed)
   * 'block' — never expose regardless of risk level
   */
  riskOverride?:    'allow' | 'block'
  /**
   * Explicit dependency declarations. Each element is a fullyQualifiedId
   * ("{appSlug}/{capabilityId}") that this capability depends on.
   * Cycle detection runs on every publish — circular dependencies are rejected.
   */
  dependsOn?:       string[]
  publishedAt:      string
  deprecatedAt?:    string
  /** fullyQualifiedId of the replacement capability */
  successor?:       string
}
export interface InvocationLogEntry {
  ts: string
  capabilityId: string
  verdict: 'clear' | 'marginal' | 'uncertain'
  resolvedVia: 'cache' | 'keyword' | 'llm'
  durationMs: number
  dryRun: boolean
  params: string[]
  error: string | null
}
