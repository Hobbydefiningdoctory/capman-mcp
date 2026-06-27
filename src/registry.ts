/**
 * registry.ts — Capability registry for governance and lifecycle management.
 *
 * Stores RegistryEntry records in a JSON file.  The registry acts as the
 * approval gate for which capabilities are surfaced as MCP tools, replacing
 * the static allowedCapabilities config list when registryPath is configured.
 *
 * Each entry carries: approval state, risk level, dependency declarations,
 * schema hash (for change detection), and lifecycle status.
 *
 * This module is pure business logic — no CLI concerns, no MCP concerns.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { Capability, Manifest } from 'capman'
import type { RegistryEntry, RiskLevel } from './types'
import { deriveRiskLevel } from './risk'
import { buildDependencyGraph, detectCycles } from './graph'

// ── slug helpers ──────────────────────────────────────────────────────────────

/**
 * Convert an app name to a URL-safe slug.
 * "My App!" → "my-app"
 */
export function toAppSlug(appName: string): string {
  return appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build the fully-qualified capability ID: "{appSlug}/{capabilityId}".
 */
export function toFullyQualifiedId(appName: string, capabilityId: string): string {
  return `${toAppSlug(appName)}/${capabilityId}`
}

// ── schema hash ───────────────────────────────────────────────────────────────

/**
 * SHA-256 of the JSON-serialised capability definition.
 * Changes whenever any field on the capability changes.
 */
export function computeSchemaHash(capability: Capability): string {
  return crypto.createHash('sha256').update(JSON.stringify(capability)).digest('hex')
}

// ── storage ───────────────────────────────────────────────────────────────────

function defaultRegistryPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
  return path.join(home, '.capman-mcp', 'registry.json')
}

export function loadRegistry(registryPath?: string): RegistryEntry[] {
  const p = registryPath ?? defaultRegistryPath()
  if (!fs.existsSync(p)) return []
  const entries = JSON.parse(fs.readFileSync(p, 'utf8')) as RegistryEntry[]
  // Backfill optional fields for entries that predate their introduction.
  // 'medium' is the conservative safe default for riskLevel — not auto-blocked,
  // but requires manual review before being exposed as a high-risk MCP tool.
  return entries.map(e => ({
    ...e,
    riskLevel: e.riskLevel ?? ('medium' as RiskLevel),
    dependsOn: e.dependsOn  ?? [],
  }))
}

export function saveRegistry(entries: RegistryEntry[], registryPath?: string): void {
  const p = registryPath ?? defaultRegistryPath()
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(entries, null, 2))
}

// ── publish ───────────────────────────────────────────────────────────────────

export interface PublishOptions {
  owner?:          string
  registryPath?:   string
  approvedForMcp?: boolean
  dependsOn?: string[]
}

export interface PublishResult {
  created: string[]
  updated: string[]
  unchanged: string[]
}

/**
 * Register or update all capabilities from a manifest.
 * Returns counts of created / updated / unchanged entries.
 */
export function publishManifest(manifest: Manifest, options: PublishOptions = {}): PublishResult {
  const entries = loadRegistry(options.registryPath)
  const now = new Date().toISOString()
  const owner = options.owner ?? 'unknown'
  const approved = options.approvedForMcp ?? true
  const result: PublishResult = { created: [], updated: [], unchanged: [] }

  for (const cap of manifest.capabilities) {
    const fqId = toFullyQualifiedId(manifest.app, cap.id)
    const hash = computeSchemaHash(cap)
    const i = entries.findIndex(e => e.fullyQualifiedId === fqId)

    if (i === -1) {
      entries.push({
        fullyQualifiedId: fqId,
        schemaVersion: manifest.schemaVersion ?? '1.0',
        owner,
        status: cap.lifecycle?.status ?? 'stable',
        schemaHash: hash,
        approvedForMcp: approved,
        riskLevel: deriveRiskLevel(cap),
        dependsOn: options.dependsOn ?? [],
        publishedAt: now,
      })
      result.created.push(fqId)
    } else if (entries[i].schemaHash !== hash) {
      entries[i] = {
        ...entries[i],
        schemaVersion: manifest.schemaVersion ?? entries[i].schemaVersion,
        status: cap.lifecycle?.status ?? entries[i].status,
        schemaHash: hash,
        approvedForMcp: approved,
        riskLevel: deriveRiskLevel(cap),
        // Only update dependsOn when explicitly passed — do not clobber
        // existing declarations when the flag is omitted.
        ...(options.dependsOn !== undefined && { dependsOn: options.dependsOn }),
        publishedAt: now,
      }
      result.updated.push(fqId)
    } else {
      result.unchanged.push(fqId)
    }
  }
  
  // Cycle detection — runs on the full proposed graph before any write.
  // If a cycle is found, CycleError is thrown and the registry is not modified.
  const graph = buildDependencyGraph(entries)
  detectCycles(graph)
  saveRegistry(entries, options.registryPath)
  return result
}

// ── deprecate ─────────────────────────────────────────────────────────────────

export interface DeprecateOptions {
  successor?: string
  registryPath?: string
}

/**
 * Mark a registry entry as deprecated.
 * Sets status → 'deprecated', approvedForMcp → false, deprecatedAt → now.
 * Throws if the fullyQualifiedId is not found.
 */
export function deprecateCapability(fqId: string, options: DeprecateOptions = {}): RegistryEntry {
  const entries = loadRegistry(options.registryPath)
  const i = entries.findIndex(e => e.fullyQualifiedId === fqId)
  if (i === -1) throw new Error(`Registry entry "${fqId}" not found`)

  entries[i] = {
    ...entries[i],
    status: 'deprecated',
    approvedForMcp: false,
    deprecatedAt: new Date().toISOString(),
    ...(options.successor !== undefined ? { successor: options.successor } : {}),
  }

  saveRegistry(entries, options.registryPath)
  return entries[i]
}

// ── list ──────────────────────────────────────────────────────────────────────

export interface ListOptions {
  appSlug?: string
  registryPath?: string
}

/**
 * Return all registry entries, optionally filtered to a single app.
 */
export function listRegistry(options: ListOptions = {}): RegistryEntry[] {
  const entries = loadRegistry(options.registryPath)
  if (!options.appSlug) return entries
  return entries.filter(e => e.fullyQualifiedId.startsWith(`${options.appSlug}/`))
}

// ── diff ──────────────────────────────────────────────────────────────────────

export type DiffStatus = 'new' | 'changed' | 'removed' | 'unchanged'

export interface DiffEntry {
  fullyQualifiedId: string
  status: DiffStatus
  riskLevel?: RiskLevel
  previousHash?: string
  currentHash?: string
}

/**
 * Compare the current manifest's capabilities against what is stored in the
 * registry.  Returns one DiffEntry per capability, annotated with status:
 *   'new'       — in manifest, not in registry
 *   'changed'   — in both, but schema hash differs
 *   'unchanged' — in both, hash matches
 *   'removed'   — in registry, not in manifest
 */
export function diffManifestVsRegistry(
  manifest: Manifest,
  options: { registryPath?: string } = {},
): DiffEntry[] {
  const allEntries = loadRegistry(options.registryPath)
  const appSlug = toAppSlug(manifest.app)
  const appEntries = allEntries.filter(e => e.fullyQualifiedId.startsWith(`${appSlug}/`))
  const result: DiffEntry[] = []

  for (const cap of manifest.capabilities) {
    const fqId = toFullyQualifiedId(manifest.app, cap.id)
    const hash = computeSchemaHash(cap)
    const existing = appEntries.find(e => e.fullyQualifiedId === fqId)

    if (!existing) {
      result.push({
        fullyQualifiedId: fqId,
        status: 'new',
        riskLevel: deriveRiskLevel(cap),
        currentHash: hash,
      })
    } else if (existing.schemaHash !== hash) {
      result.push({
        fullyQualifiedId: fqId,
        status: 'changed',
        riskLevel: deriveRiskLevel(cap),
        previousHash: existing.schemaHash,
        currentHash: hash,
      })
    } else {
      result.push({
        fullyQualifiedId: fqId,
        status: 'unchanged',
        riskLevel: existing.riskLevel,
        currentHash: hash,
      })
    }
  }

  const manifestFqIds = new Set(
    manifest.capabilities.map(c => toFullyQualifiedId(manifest.app, c.id)),
  )
  for (const entry of appEntries) {
    if (!manifestFqIds.has(entry.fullyQualifiedId)) {
      result.push({
        fullyQualifiedId: entry.fullyQualifiedId,
        status: 'removed',
        previousHash: entry.schemaHash,
      })
    }
  }

  return result
}
