/**
 * capman-mcp — MCP adapter for capman
 *
 * Single entry point. Consumers only need one import path:
 *   import { ConcurrentCapmanEngine, validateOutputSchema, buildToolList } from 'capman-mcp'
 *
 * Includes:
 *   - Full capman public API (re-exported wholesale — capman is unmodified)
 *   - MCP-side output schema types (CapabilityWithOutput, CapabilityOutputSchema, …)
 *   - Config types (CapmanMcpConfig, AllowedCapabilityEntry)
 *   - Zod validation helpers (CapabilityOutputSchemaZod, validateOutputSchema)
 *   - Bridge (buildToolList)
 *   - Schema derivation (deriveInputSchema, deriveOutputSchema, enrichWithOutputSchemas)
 *   - Output validation (validateEngineResultOutput)
 *   - Logger (InvocationLogger)
 *   - Server (startServer, startDemo)
 */

export * from 'capman'

export { deriveRiskLevel, maxRisk } from './risk'
export type { RiskLevel } from './risk'

export type {
  CapabilityOutputPropertyType,
  CapabilityOutputProperty,
  CapabilityOutputSchema,
  CapabilityWithOutput,
  AllowedCapabilityEntry,
  CapmanMcpConfig,
  InvocationLogEntry,
  RegistryEntry,
} from './types'

export {
  CapabilityOutputPropertySchema,
  CapabilityOutputSchemaZod,
  validateOutputSchema,
} from './schema'
export type { OutputSchemaValidationResult } from './schema'

export { loadConfig, validateAllowlist } from './allowlist'
export type { McpTool } from './allowlist'

export {
  deriveInputSchema,
  deriveOutputSchema,
  enrichWithOutputSchemas,
} from './schema-derive'
export type { McpInputSchema } from './schema-derive'

export { validateEngineResultOutput } from './output-validate'
export type { OutputValidationWarning } from './output-validate'

export { buildToolList } from './bridge'
export type { McpToolDefinition } from './bridge'

export { InvocationLogger } from './logger'

export { startServer, startDemo, callTool } from './server'

export {
  toAppSlug,
  toFullyQualifiedId,
  computeSchemaHash,
  loadRegistry,
  saveRegistry,
  publishManifest,
  deprecateCapability,
  listRegistry,
  diffManifestVsRegistry,
} from './registry'
export type {
  PublishOptions,
  PublishResult,
  DeprecateOptions,
  ListOptions,
  DiffEntry,
  DiffStatus,
} from './registry'

export { resolveById } from './resolve'
export type { ResolveByIdOptions } from './resolve'

export {
  buildDependencyGraph,
  detectCycles,
  getImpactedCapabilities,
  CycleError,
} from './graph'
export type { DependencyGraph } from './graph'

export { startCatalog } from './catalog'
export type { CatalogOptions } from './catalog'
