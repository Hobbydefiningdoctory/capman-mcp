import * as fs from 'fs'
import * as path from 'path'
import type { Manifest } from 'capman'
import type { CapmanMcpConfig, AllowedCapabilityEntry } from './types'

export interface McpTool {
  name: string
}

/**
 * Load a CapmanMcpConfig from a JS or JSON config file.
 * JS config files must use CommonJS module.exports.
 */
export function loadConfig(configPath: string): CapmanMcpConfig {
  const resolved = path.resolve(configPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`capman-mcp: config file not found: ${resolved}`)
  }
  const ext = path.extname(resolved)
  let config: CapmanMcpConfig
  if (ext === '.json') {
    config = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as CapmanMcpConfig
  } else {
    config = require(resolved) as CapmanMcpConfig
  }
  validateConfig(config)
  return config
}

function validateConfig(config: CapmanMcpConfig): void {
  if (!config.manifest || typeof config.manifest !== 'string') {
    throw new Error('capman-mcp: config.manifest must be a non-empty string path')
  }
  if (!Array.isArray(config.allowedCapabilities)) {
    throw new Error('capman-mcp: config.allowedCapabilities must be an array')
  }
  for (const entry of config.allowedCapabilities) {
    if (!entry.id || typeof entry.id !== 'string') {
      throw new Error(`capman-mcp: each allowedCapabilities entry must have a string id`)
    }
  }
}

/**
 * Warn about allowlist entries that are missing from the manifest or were
 * filtered out (non-public or deprecated). Does not throw — operator errors
 * should surface as warnings, not crashes.
 */
export function validateAllowlist(
  allowedCapabilities: AllowedCapabilityEntry[],
  manifest: Manifest,
  tools: McpTool[],
): void {
  const manifestIds = new Set(manifest.capabilities.map(c => c.id))
  const builtIds = new Set(tools.map(t => t.name))

  for (const entry of allowedCapabilities) {
    if (!manifestIds.has(entry.id)) {
      process.stderr.write(
        `[capman-mcp] WARN: allowlist entry "${entry.id}" not found in manifest — skipped\n`,
      )
    } else if (!builtIds.has(entry.id)) {
      process.stderr.write(
        `[capman-mcp] WARN: allowlist entry "${entry.id}" filtered out (non-public or deprecated) — not exposed as MCP tool\n`,
      )
    }
  }
}
