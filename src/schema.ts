import { z } from 'zod'
import type { ZodType } from 'zod'
import type { CapabilityOutputProperty } from './types'

/**
 * Recursive Zod schema for a single output property.
 * Uses z.lazy() with an explicit ZodType annotation to avoid circular
 * inference errors in Zod v3 (required — do not remove the annotation).
 */
export const CapabilityOutputPropertySchema: ZodType<CapabilityOutputProperty> = z.lazy(() =>
  z.object({
    type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']),
    description: z.string().optional(),
    format: z.string().optional(),
    items: CapabilityOutputPropertySchema.optional(),
    properties: z.record(z.string(), CapabilityOutputPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
)

/**
 * Top-level output schema validator.
 * Enforces type: 'object' and at least one property entry.
 */
export const CapabilityOutputSchemaZod = z.object({
  type: z.literal('object'),
  properties: z
    .record(z.string(), CapabilityOutputPropertySchema)
    .refine(v => Object.keys(v).length > 0, {
      message: 'outputSchema.properties must have at least one entry',
    }),
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
})

export type OutputSchemaValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] }

/**
 * Validate an unknown value against the CapabilityOutputSchema contract.
 * Returns { valid: true } or { valid: false, errors: string[] } with
 * human-readable messages — no Zod import required for callers.
 */
export function validateOutputSchema(schema: unknown): OutputSchemaValidationResult {
  const result = CapabilityOutputSchemaZod.safeParse(schema)
  if (result.success) {
    return { valid: true }
  }
  return {
    valid: false,
    errors: result.error.issues.map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') + ': ' : ''
      return `${path}${issue.message}`
    }),
  }
}
