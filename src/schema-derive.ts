import * as fs from 'fs'
import type { Capability, CapabilityParam } from 'capman'
import type { CapabilityOutputSchema, CapabilityOutputProperty, CapabilityWithOutput } from './types'

const MAX_REF_DEPTH = 3

type JsonSchemaObject = Record<string, unknown>

export interface McpInputSchema {
  type: 'object'
  properties: Record<string, JsonSchemaObject>
  required: string[]
}

/**
 * Derive an MCP tool inputSchema from a capability's params array.
 *
 * SECURITY: Only params with source === 'user_query' are included.
 * Params with source === 'session' are auth-injected and must NEVER
 * appear in the MCP input schema — leaking them allows callers to
 * supply a userId and impersonate another user.
 */
export function deriveInputSchema(params: CapabilityParam[] = []): McpInputSchema {
  const properties: Record<string, JsonSchemaObject> = {}
  const required: string[] = []

  for (const param of params) {
    if (param.source !== 'user_query') continue

    properties[param.name] = paramToJsonSchemaProp(param)
    if (param.required) required.push(param.name)
  }

  return { type: 'object', properties, required }
}

function paramToJsonSchemaProp(param: CapabilityParam): JsonSchemaObject {
  const prop: JsonSchemaObject = {}

  if (param.description) prop.description = param.description

  switch (param.type) {
    case 'number':
      prop.type = 'number'
      break
    case 'boolean':
      prop.type = 'boolean'
      break
    case 'email':
      prop.type = 'string'
      prop.format = 'email'
      break
    case 'url':
      prop.type = 'string'
      prop.format = 'uri'
      break
    case 'date':
      prop.type = 'string'
      prop.format = 'date'
      break
    case 'enum':
      prop.type = 'string'
      if (param.enum?.length) prop.enum = param.enum
      break
    case 'object':
      prop.type = 'object'
      break
    case 'string':
    default:
      prop.type = 'string'
  }

  if (param.example !== undefined) prop.examples = [param.example]

  return prop
}

/**
 * Convert a CapabilityOutputSchema (our internal type) into a plain JSON Schema
 * object suitable for use as an MCP tool outputSchema.
 */
export function deriveOutputSchema(schema: CapabilityOutputSchema): JsonSchemaObject {
  const result: JsonSchemaObject = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, outputPropertyToJsonSchema(v)]),
    ),
  }
  if (schema.required?.length) result.required = schema.required
  if (schema.description) result.description = schema.description
  return result
}

function outputPropertyToJsonSchema(prop: CapabilityOutputProperty): JsonSchemaObject {
  const out: JsonSchemaObject = { type: prop.type }
  if (prop.description) out.description = prop.description
  if (prop.format) out.format = prop.format
  if (prop.enum) out.enum = prop.enum
  if (prop.items) out.items = outputPropertyToJsonSchema(prop.items)
  if (prop.properties) {
    out.properties = Object.fromEntries(
      Object.entries(prop.properties).map(([k, v]) => [k, outputPropertyToJsonSchema(v)]),
    )
  }
  if (prop.required?.length) out.required = prop.required
  return out
}

/**
 * Re-read an OpenAPI spec at MCP server startup and enrich a Capability[]
 * with outputSchema fields derived from the spec's response schemas.
 * capman is not involved — enrichment lives entirely in capman-mcp.
 */
  export function enrichWithOutputSchemas(
    caps: Capability[],
    specPath: string,
  ): CapabilityWithOutput[] {
    if (specPath.startsWith('http://') || specPath.startsWith('https://')) {
      throw new Error(
        `capman-mcp: enrichWithOutputSchemas does not support URL specs.\n` +
        `Download the spec to a local file and pass the file path instead.\n` +
        `Quick download: curl -o spec.json "${specPath}"`,
      )
    }
    const ext = specPath.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'yaml' || ext === 'yml') {
      throw new Error(
        `capman-mcp: enrichWithOutputSchemas does not support YAML specs yet.\n` +
        `Convert "${specPath}" to JSON and pass the .json path instead.\n` +
        `Quick conversion: npx js-yaml "${specPath}" > spec.json`,
      )
    }
    const raw = fs.readFileSync(specPath, 'utf-8')
    const spec = JSON.parse(raw) as JsonSchemaObject

  const allSchemas =
    ((spec.components as JsonSchemaObject | undefined)?.schemas as Record<string, JsonSchemaObject> | undefined) ??
    (spec.definitions as Record<string, JsonSchemaObject> | undefined) ??
    {}

  return caps.map(cap => ({
    ...cap,
    outputSchema: deriveOutputSchemaFromSpec(cap.id, spec, allSchemas),
  }))
}

function deriveOutputSchemaFromSpec(
  capabilityId: string,
  spec: JsonSchemaObject,
  allSchemas: Record<string, JsonSchemaObject>,
): CapabilityOutputSchema | undefined {
  const paths = (spec.paths as Record<string, JsonSchemaObject> | undefined) ?? {}

  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== 'object') continue
      const op = operation as JsonSchemaObject

      const opId = ((op.operationId as string | undefined) ?? '')
        .toLowerCase()
        .replace(/[-\s]/g, '_')

      if (opId !== capabilityId) continue

      const responses = op.responses as Record<string, JsonSchemaObject> | undefined
      if (!responses) continue

      const successRes =
        (responses['200'] ?? responses['201']) as JsonSchemaObject | undefined
      if (!successRes) continue

      const content = successRes.content as Record<string, JsonSchemaObject> | undefined
      const jsonMedia = content?.['application/json'] as JsonSchemaObject | undefined
      const rawSchema = jsonMedia?.schema as JsonSchemaObject | undefined
      if (!rawSchema) continue

      const resolved = resolveRef(rawSchema, allSchemas, 0)
      if (!resolved) continue

      return convertToOutputSchema(resolved, allSchemas, 0)
    }
  }
  return undefined
}

function resolveRef(
  schema: JsonSchemaObject,
  allSchemas: Record<string, JsonSchemaObject>,
  depth: number,
): JsonSchemaObject | null {
  if (depth > MAX_REF_DEPTH) return null

  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()!
    const target = allSchemas[name]
    if (!target) return null
    return resolveRef(target, allSchemas, depth + 1)
  }

  if (Array.isArray(schema.allOf)) {
    return mergeAllOf(schema.allOf as JsonSchemaObject[], allSchemas, depth)
  }

  return schema
}

function mergeAllOf(
  schemas: JsonSchemaObject[],
  allSchemas: Record<string, JsonSchemaObject>,
  depth: number,
): JsonSchemaObject {
  const merged: JsonSchemaObject = { type: 'object', properties: {} }
  for (const s of schemas) {
    const resolved = resolveRef(s, allSchemas, depth + 1)
    if (!resolved) continue
    const props = resolved.properties as Record<string, JsonSchemaObject> | undefined
    if (props) Object.assign(merged.properties as object, props)
  }
  return merged
}

function convertToOutputSchema(
  schema: JsonSchemaObject,
  allSchemas: Record<string, JsonSchemaObject>,
  depth: number,
): CapabilityOutputSchema | undefined {
  if (depth > MAX_REF_DEPTH) return undefined
  if (schema.type !== 'object') return undefined

  const rawProps = schema.properties as Record<string, JsonSchemaObject> | undefined
  if (!rawProps || Object.keys(rawProps).length === 0) return undefined

  const properties: Record<string, CapabilityOutputProperty> = {}
  for (const [key, rawProp] of Object.entries(rawProps)) {
    const resolved = resolveRef(rawProp, allSchemas, depth + 1)
    if (!resolved) continue
    const converted = convertToOutputProperty(resolved, allSchemas, depth + 1)
    if (converted) properties[key] = converted
  }

  if (Object.keys(properties).length === 0) return undefined

  const result: CapabilityOutputSchema = { type: 'object', properties }
  if (Array.isArray(schema.required)) result.required = schema.required as string[]
  return result
}

const VALID_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object', 'null'])

function convertToOutputProperty(
  schema: JsonSchemaObject,
  allSchemas: Record<string, JsonSchemaObject>,
  depth: number,
): CapabilityOutputProperty | null {
  if (depth > MAX_REF_DEPTH) return null

  const rawType = schema.type as string | undefined
  const outType: CapabilityOutputProperty['type'] = VALID_OUTPUT_TYPES.has(rawType ?? '')
    ? (rawType as CapabilityOutputProperty['type'])
    : 'string'

  const prop: CapabilityOutputProperty = { type: outType }
  if (schema.description) prop.description = schema.description as string
  if (schema.format) prop.format = schema.format as string
  if (Array.isArray(schema.enum)) prop.enum = schema.enum as (string | number | boolean)[]
  if (Array.isArray(schema.required)) prop.required = schema.required as string[]

  if (outType === 'array' && schema.items) {
    const resolved = resolveRef(schema.items as JsonSchemaObject, allSchemas, depth + 1)
    if (resolved) {
      const items = convertToOutputProperty(resolved, allSchemas, depth + 1)
      if (items) prop.items = items
    }
  }

  if (outType === 'object' && schema.properties) {
    const rawProps = schema.properties as Record<string, JsonSchemaObject>
    const properties: Record<string, CapabilityOutputProperty> = {}
    for (const [k, v] of Object.entries(rawProps)) {
      const resolved = resolveRef(v, allSchemas, depth + 1)
      if (!resolved) continue
      const converted = convertToOutputProperty(resolved, allSchemas, depth + 1)
      if (converted) properties[k] = converted
    }
    if (Object.keys(properties).length > 0) prop.properties = properties
  }

  return prop
}
