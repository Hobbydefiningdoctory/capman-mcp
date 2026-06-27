import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deriveInputSchema, deriveOutputSchema, enrichWithOutputSchemas } from '../src/schema-derive'
import type { Capability } from 'capman'
import type { CapabilityParam } from 'capman'
import type { CapabilityOutputSchema } from '../src/types'

describe('deriveInputSchema', () => {
  it('returns empty schema for no params', () => {
    const schema = deriveInputSchema([])
    expect(schema.type).toBe('object')
    expect(schema.properties).toEqual({})
    expect(schema.required).toEqual([])
  })

  it('excludes session params', () => {
    const params: CapabilityParam[] = [
      { name: 'user_id', description: 'User ID', required: true, source: 'session', type: 'string' },
      { name: 'query', description: 'Search query', required: true, source: 'user_query', type: 'string' },
    ]
    const schema = deriveInputSchema(params)
    expect(Object.keys(schema.properties)).toEqual(['query'])
    expect(schema.required).toEqual(['query'])
  })

  it('maps type → string correctly', () => {
    const params: CapabilityParam[] = [
      { name: 'q', description: 'query', required: false, source: 'user_query', type: 'string' },
    ]
    expect(deriveInputSchema(params).properties.q).toMatchObject({ type: 'string' })
  })

  it('maps type → number', () => {
    const params: CapabilityParam[] = [
      { name: 'limit', description: 'limit', required: false, source: 'user_query', type: 'number' },
    ]
    expect(deriveInputSchema(params).properties.limit).toMatchObject({ type: 'number' })
  })

  it('maps type email → string + format', () => {
    const params: CapabilityParam[] = [
      { name: 'email', description: 'email', required: false, source: 'user_query', type: 'email' },
    ]
    expect(deriveInputSchema(params).properties.email).toMatchObject({ type: 'string', format: 'email' })
  })

  it('maps type url → string + format uri', () => {
    const params: CapabilityParam[] = [
      { name: 'link', description: 'link', required: false, source: 'user_query', type: 'url' },
    ]
    expect(deriveInputSchema(params).properties.link).toMatchObject({ type: 'string', format: 'uri' })
  })

  it('maps type date → string + format date', () => {
    const params: CapabilityParam[] = [
      { name: 'date', description: 'date', required: false, source: 'user_query', type: 'date' },
    ]
    expect(deriveInputSchema(params).properties.date).toMatchObject({ type: 'string', format: 'date' })
  })

  it('maps type enum → string + enum values', () => {
    const params: CapabilityParam[] = [
      { name: 'status', description: 'status', required: false, source: 'user_query', type: 'enum', enum: ['active', 'inactive'] },
    ]
    expect(deriveInputSchema(params).properties.status).toMatchObject({ type: 'string', enum: ['active', 'inactive'] })
  })

  it('includes examples when param.example is set', () => {
    const params: CapabilityParam[] = [
      { name: 'order_id', description: 'order', required: true, source: 'user_query', type: 'string', example: 'ORD-123' },
    ]
    expect(deriveInputSchema(params).properties.order_id).toMatchObject({ examples: ['ORD-123'] })
  })

  it('puts required user_query params in required array', () => {
    const params: CapabilityParam[] = [
      { name: 'a', description: 'a', required: true, source: 'user_query' },
      { name: 'b', description: 'b', required: false, source: 'user_query' },
    ]
    const schema = deriveInputSchema(params)
    expect(schema.required).toContain('a')
    expect(schema.required).not.toContain('b')
  })
})

describe('deriveOutputSchema', () => {
  it('converts a flat object outputSchema to JSON Schema', () => {
    const schema: CapabilityOutputSchema = {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order ID' },
        total: { type: 'number' },
      },
      required: ['order_id'],
    }
    const result = deriveOutputSchema(schema)
    expect(result.type).toBe('object')
    expect((result.properties as Record<string, unknown>).order_id).toMatchObject({ type: 'string', description: 'Order ID' })
    expect(result.required).toContain('order_id')
  })

  it('converts nested array items', () => {
    const schema: CapabilityOutputSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    }
    const result = deriveOutputSchema(schema)
    const items = (result.properties as Record<string, unknown>).items as Record<string, unknown>
    expect(items.type).toBe('array')
    expect((items.items as Record<string, unknown>).type).toBe('string')
  })
})

// ─── enrichWithOutputSchemas ──────────────────────────────────────────────────

function makeMinimalCap(id: string): Capability {
  return {
    id,
    name: id,
    description: `Test capability ${id}`,
    examples: [],
    params: [],
    returns: [],
    resolver: { type: 'api', endpoints: [] },
    privacy: { level: 'public' },
    lifecycle: { status: 'stable' },
  } as unknown as Capability
}

describe('enrichWithOutputSchemas', () => {
  const tmpFiles: string[] = []

  function writeTempSpec(spec: object): string {
    const file = path.join(
      os.tmpdir(),
      `capman-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    )
    fs.writeFileSync(file, JSON.stringify(spec))
    tmpFiles.push(file)
    return file
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* already gone */ }
    }
    tmpFiles.length = 0
  })

  it('derives outputSchema from a flat OAS3 response schema', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/orders/{order_id}': {
          get: {
            operationId: 'get_order',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', description: 'Order ID' },
                        total: { type: 'number' },
                        shipped: { type: 'boolean' },
                      },
                      required: ['id'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_order')], writeTempSpec(spec))

    expect(result).toHaveLength(1)
    expect(result[0].outputSchema).toBeDefined()
    expect(result[0].outputSchema!.type).toBe('object')
    const props = result[0].outputSchema!.properties as Record<string, CapabilityOutputSchema>
    expect(props).toHaveProperty('id')
    expect(props.id.type).toBe('string')
    expect(props.id.description).toBe('Order ID')
    expect(props).toHaveProperty('total')
    expect(props.total.type).toBe('number')
    expect(props).toHaveProperty('shipped')
    expect(props.shipped.type).toBe('boolean')
    expect(result[0].outputSchema!.required).toContain('id')
  })

  it('resolves $ref to components/schemas', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      components: {
        schemas: {
          Product: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              price: { type: 'number' },
            },
          },
        },
      },
      paths: {
        '/products/{sku}': {
          get: {
            operationId: 'get_product',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Product' },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_product')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeDefined()
    const props = result[0].outputSchema!.properties as Record<string, unknown>
    expect(props).toHaveProperty('sku')
    expect(props).toHaveProperty('price')
  })

  it('resolves $ref to Swagger 2.0 definitions section', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      definitions: {
        Order: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      paths: {
        '/orders/{id}': {
          get: {
            operationId: 'get_order',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/definitions/Order' },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_order')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeDefined()
    const props = result[0].outputSchema!.properties as Record<string, unknown>
    expect(props).toHaveProperty('order_id')
    expect(props).toHaveProperty('status')
  })

  it('merges allOf sub-schemas into a single outputSchema', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/items/{id}': {
          get: {
            operationId: 'get_item',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { type: 'object', properties: { id: { type: 'string' } } },
                        { type: 'object', properties: { name: { type: 'string' } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_item')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeDefined()
    const props = result[0].outputSchema!.properties as Record<string, unknown>
    expect(props).toHaveProperty('id')
    expect(props).toHaveProperty('name')
  })

  it('falls back to 201 response when 200 is absent', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/orders': {
          post: {
            operationId: 'create_order',
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { order_id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('create_order')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeDefined()
    const props = result[0].outputSchema!.properties as Record<string, unknown>
    expect(props).toHaveProperty('order_id')
  })

  it('leaves outputSchema undefined when no operationId matches the capability id', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/other': {
          get: {
            operationId: 'completely_different_operation',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { x: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_order')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeUndefined()
  })

  it('matches operationId case-insensitively with dashes normalised to underscores', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/orders': {
          get: {
            operationId: 'Get-Order',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    }

    const result = enrichWithOutputSchemas([makeMinimalCap('get_order')], writeTempSpec(spec))

    expect(result[0].outputSchema).toBeDefined()
  })

  it('throws a descriptive error for YAML spec paths', () => {
    expect(() => enrichWithOutputSchemas([], '/path/to/api.yaml'))
      .toThrow(/YAML/i)
    expect(() => enrichWithOutputSchemas([], '/path/to/api.yml'))
      .toThrow(/YAML/i)
  })
})
