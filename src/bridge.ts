import type { Manifest } from 'capman'
import type { CapabilityWithOutput, CapmanMcpConfig, AllowedCapabilityEntry, RegistryEntry } from './types'
import { deriveInputSchema, deriveOutputSchema } from './schema-derive'
import { toAppSlug } from './registry'
import { deriveRiskLevel } from './risk'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
  outputSchema?: Record<string, unknown>
}

/**
 * Convert a single capability + allowlist entry into an MCP tool definition.
 */
function capabilityToTool(
  cap: CapabilityWithOutput,
  entry: AllowedCapabilityEntry,
): McpToolDefinition {
  return {
    name: cap.id,
    description: entry.descriptionOverride ?? cap.description,
    inputSchema: deriveInputSchema(cap.params),
    outputSchema: cap.outputSchema ? deriveOutputSchema(cap.outputSchema) : undefined,
  }
}

/**
 * Build the approved MCP tool list from a manifest and config.
 *
 * Filters applied in order:
 *   1. Approval check — one of two modes:
 *      a. Registry mode (registry provided): capability must have an entry
 *         with approvedForMcp === true in the registry.
 *      b. Config mode (no registry): capability must be in allowedCapabilities.
 *   *   2. Privacy filter:
 *      - public capabilities always pass.
 *      - user_owned capabilities pass when config.auth.isAuthenticated === true.
 *      - admin capabilities are always blocked, regardless of auth.
 *   3. Must not have lifecycle.status === 'deprecated'
 *
 * In both modes, allowedCapabilities entries still act as an override layer
 * for per-capability settings (descriptionOverride, dryRunOverride, allowHighRisk).
 */
export function buildToolList(
  manifest: Manifest,
  config: CapmanMcpConfig,
  registry?: RegistryEntry[],
): McpToolDefinition[] {
  const overrideMap = new Map(config.allowedCapabilities.map(e => [e.id, e]))

  const gate = config.policyGate !== false  // default true

  const isApproved = (capId: string): boolean => {
    if (registry !== undefined) {
      const fqId = `${toAppSlug(manifest.app)}/${capId}`
      return registry.some(e => e.fullyQualifiedId === fqId && e.approvedForMcp)
    }
    return overrideMap.has(capId)
  }

  /**
   * Policy gate — blocks high-risk capabilities unless explicitly opted in.
   *
   * Config mode:   entry.allowHighRisk === true bypasses the block.
   * Registry mode: registryEntry.riskOverride === 'allow' bypasses the block.
   *                registryEntry.riskOverride === 'block' always blocks.
   *
   * When policyGate is false the gate is disabled entirely.
   */
  const passesRiskGate = (capId: string): boolean => {
    if (!gate) return true

    const cap  = manifest.capabilities.find(c => c.id === capId)!
    const risk = deriveRiskLevel(cap)
    if (risk !== 'high') return true

    // high-risk: check for explicit opt-in
    if (registry !== undefined) {
      const fqId = `${toAppSlug(manifest.app)}/${capId}`
      const entry = registry.find(e => e.fullyQualifiedId === fqId)
      if (entry?.riskOverride === 'block') return false
      if (entry?.riskOverride === 'allow') return true
      // no override — blocked by default
      return false
    }

    // config mode: require allowHighRisk: true on the entry
    return overrideMap.get(capId)?.allowHighRisk === true
  }

  const userIsAuthenticated = config.auth?.isAuthenticated === true
  
  return manifest.capabilities
    .filter(cap => isApproved(cap.id))
    .filter(cap =>
      cap.privacy.level === 'public' ||
      (cap.privacy.level === 'user_owned' && userIsAuthenticated),
    )
    .filter(cap => cap.lifecycle?.status !== 'deprecated')
    .filter(cap => passesRiskGate(cap.id))
    .map(cap =>
      capabilityToTool(
        cap as CapabilityWithOutput,
        overrideMap.get(cap.id) ?? { id: cap.id },
      ),
    )
}
