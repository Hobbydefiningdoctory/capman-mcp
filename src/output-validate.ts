import type { EngineResult } from 'capman'
import type { CapabilityWithOutput, CapabilityOutputSchema, CapabilityOutputProperty } from './types'

export interface OutputValidationWarning {
  capabilityId: string
  errors: string[]
}

/**
 * Validate an engine result's data payload against the capability's declared
 * outputSchema. Always returns null when no outputSchema is present.
 *
 * Per roadmap: the live API result is authoritative — this logs a warning on
 * mismatch but never throws or blocks the response.
 */
export function validateEngineResultOutput(
  result: EngineResult,
  cap: CapabilityWithOutput | undefined,
): OutputValidationWarning | null {
  if (!cap?.outputSchema) return null
  if (!result.resolution.success) return null

  const data = result.resolution.data
  const errors = checkData(data, cap.outputSchema, '')

  if (errors.length === 0) return null
  return { capabilityId: cap.id, errors }
}

function checkData(
  data: unknown,
  schema: CapabilityOutputSchema,
  path: string,
): string[] {
  const errors: string[] = []
  const prefix = path ? `${path}.` : ''

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push(
      `${prefix || 'root'}: expected object, got ${Array.isArray(data) ? 'array' : typeof data}`,
    )
    return errors
  }

  const obj = data as Record<string, unknown>

  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in obj)) {
        errors.push(`${prefix}${key}: required property missing`)
      }
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue
    const propErrors = checkProperty(obj[key], propSchema, `${prefix}${key}`)
    errors.push(...propErrors)
  }

  return errors
}

function checkProperty(
  value: unknown,
  schema: CapabilityOutputProperty,
  path: string,
): string[] {
  const errors: string[] = []

  if (value === null) {
    if (schema.type !== 'null') {
      errors.push(`${path}: expected ${schema.type}, got null`)
    }
    return errors
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeof value}`)
      break
    case 'number':
      if (typeof value !== 'number') errors.push(`${path}: expected number, got ${typeof value}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`)
      break
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`)
      } else if (schema.items) {
        value.forEach((item, i) => {
          errors.push(...checkProperty(item, schema.items!, `${path}[${i}]`))
        })
      }
      break
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`)
      } else if (schema.properties) {
        const obj = value as Record<string, unknown>
        if (schema.required) {
          for (const key of schema.required) {
            if (!(key in obj)) errors.push(`${path}.${key}: required property missing`)
          }
        }
        for (const [k, subSchema] of Object.entries(schema.properties)) {
          if (k in obj) errors.push(...checkProperty(obj[k], subSchema, `${path}.${k}`))
        }
      }
      break
  }

  return errors
}
