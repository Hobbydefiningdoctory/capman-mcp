#!/usr/bin/env node
'use strict'

const { startServer, startDemo } = require('../dist/cjs/server')

const args = process.argv.slice(2)
const command = args[0]

function printUsage() {
  process.stderr.write(
    [
      'capman-mcp — MCP adapter for capman',
      '',
      'Usage:',
      '  capman-mcp start --config <path>            Start the MCP server with a config file',
      '  capman-mcp demo                             Run the demo server with a sample manifest',
      '  capman-mcp registry publish  --manifest <path> [--owner <name>] [--registry <path>] [--no-approved-for-mcp] [--depends-on <fqId> ...]',
      '  capman-mcp registry deprecate <fqId>        [--successor <fqId>] [--registry <path>]',
      '  capman-mcp registry list                    [--app <slug>] [--registry <path>]',
      '  capman-mcp registry diff     --manifest <path> [--registry <path>]',
      '  capman-mcp registry impact   <fqId>          [--registry <path>]',
      '  capman-mcp catalog start     --port <n> --manifest <path> [--registry <path>]',
      '  capman-mcp --help                           Show this help',
      '',
    ].join('\n'),
  )
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage()
    process.exit(0)
  }

  if (command === 'demo') {
    await startDemo()
    return
  }

  if (command === 'start') {
    const configIdx = args.indexOf('--config')
    const configPath = configIdx !== -1 ? args[configIdx + 1] : args[1]
    if (!configPath) {
      process.stderr.write('capman-mcp: --config <path> is required for "start"\n')
      printUsage()
      process.exit(1)
    }
    await startServer(configPath)
    return
  }

  if (command === 'registry') {
    const {
      publishManifest,
      deprecateCapability,
      listRegistry,
      diffManifestVsRegistry,
    } = require('../dist/cjs/registry')
    const { readManifest } = require('capman')

    const subArgs = args.slice(1)
    const subcommand = subArgs[0]

    function flag(name) {
      const idx = subArgs.indexOf(name)
      return idx !== -1 ? subArgs[idx + 1] : undefined
    }

    if (subcommand === 'publish') {
      const manifestPath = flag('--manifest')
      if (!manifestPath) {
        process.stderr.write('capman-mcp registry publish: --manifest <path> is required\n')
        process.exit(1)
      }
      // --no-approved-for-mcp publishes capabilities in a pending/review state
      // (approvedForMcp: false). Useful in CI pipelines where a human approval
      // step follows publish. Omitting the flag defaults to true (approved).
      const approvedForMcp = !subArgs.includes('--no-approved-for-mcp')

      // --depends-on <fqId> is repeatable. Collect all values into an array.
      // Example: --depends-on my-app/get_order --depends-on my-app/get_customer
      // When omitted, existing dependsOn values in the registry are preserved.
      const dependsOn = subArgs.reduce((acc, arg, idx) => {
        if (arg === '--depends-on' && subArgs[idx + 1] && !subArgs[idx + 1].startsWith('--')) {
          acc.push(subArgs[idx + 1])
        }
        return acc
      }, [])

      const manifest = readManifest(manifestPath)
      const result = publishManifest(manifest, {
        owner: flag('--owner'),
        registryPath: flag('--registry'),
        approvedForMcp,
        ...(dependsOn.length > 0 && { dependsOn }),
      })
      process.stdout.write(
        `Published (approvedForMcp: ${approvedForMcp}): ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged\n`,
      )
      for (const id of result.created) process.stdout.write(`  + ${id}\n`)
      for (const id of result.updated) process.stdout.write(`  ~ ${id}\n`)
      return
    }

    if (subcommand === 'deprecate') {
      const fqId = subArgs[1]
      if (!fqId || fqId.startsWith('-')) {
        process.stderr.write(
          'capman-mcp registry deprecate: <fullyQualifiedId> is required\n',
        )
        process.exit(1)
      }
      const entry = deprecateCapability(fqId, {
        successor: flag('--successor'),
        registryPath: flag('--registry'),
      })
      process.stdout.write(`Deprecated: ${entry.fullyQualifiedId}\n`)
      if (entry.successor) process.stdout.write(`  Successor: ${entry.successor}\n`)
      return
    }

    if (subcommand === 'list') {
      const entries = listRegistry({
        appSlug: flag('--app'),
        registryPath: flag('--registry'),
      })
      if (entries.length === 0) {
        process.stdout.write('Registry is empty.\n')
        return
      }
      process.stdout.write(
        `${'ID'.padEnd(50)} ${'STATUS'.padEnd(12)} ${'RISK'.padEnd(8)} ${'APPROVED'.padEnd(10)} OWNER\n`,
      )
      process.stdout.write(
        `${'-'.repeat(50)} ${'-'.repeat(12)} ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(20)}\n`,
      )
      for (const e of entries) {
        process.stdout.write(
          `${e.fullyQualifiedId.padEnd(50)} ${e.status.padEnd(12)} ${(e.riskLevel ?? '?').padEnd(8)} ${String(e.approvedForMcp).padEnd(10)} ${e.owner}\n`,
        )
      }
      return
    }

    if (subcommand === 'diff') {
      const manifestPath = flag('--manifest')
      if (!manifestPath) {
        process.stderr.write('capman-mcp registry diff: --manifest <path> is required\n')
        process.exit(1)
      }
      const manifest = readManifest(manifestPath)
      const diffs = diffManifestVsRegistry(manifest, { registryPath: flag('--registry') })
      if (diffs.every(d => d.status === 'unchanged')) {
        process.stdout.write('No changes detected.\n')
        return
      }
      for (const d of diffs) {
        const sym  = { new: '+', changed: '~', removed: '-', unchanged: ' ' }[d.status]
        const risk = d.riskLevel ? ` [${d.riskLevel}]` : ''
        process.stdout.write(`  ${sym} [${d.status}]${risk} ${d.fullyQualifiedId}\n`)
      }
      return
    }

  if (subcommand === 'impact') {
      const fqId = subArgs[1]
      if (!fqId || fqId.startsWith('-')) {
        process.stderr.write('capman-mcp registry impact: <fqId> is required\n')
        process.exit(1)
      }
      const { loadRegistry } = require('../dist/cjs/registry')
      const { buildDependencyGraph, getImpactedCapabilities } = require('../dist/cjs/graph')

      const entries  = loadRegistry(flag('--registry'))
      const graph    = buildDependencyGraph(entries)
      const impacted = getImpactedCapabilities(graph, fqId)

      if (impacted.length === 0) {
        process.stdout.write(`No capabilities depend on "${fqId}".\n`)
        return
      }

      process.stdout.write(`Impact analysis for: ${fqId}\n`)
      process.stdout.write(`${impacted.length} capability${impacted.length === 1 ? '' : 'ies'} would be affected if this changes:\n\n`)
      const entryMap = new Map(entries.map(e => [e.fullyQualifiedId, e]))
      for (const id of impacted) {
        const e = entryMap.get(id)
        const meta = e ? `  (${e.status}, ${e.riskLevel ?? '?'})` : ''
        process.stdout.write(`  ${id}${meta}\n`)
      }
      return
    }

    process.stderr.write(
      `capman-mcp registry: unknown subcommand "${subcommand ?? ''}"\n`,
    )
    process.stderr.write('Available: publish, deprecate, list, diff, impact\n')
    process.exit(1)
  }

  if (command === 'catalog') {
    const subcommand = args[1]
    if (subcommand !== 'start') {
      process.stderr.write(`capman-mcp catalog: unknown subcommand "${subcommand ?? ''}"\n`)
      process.stderr.write('Available: start\n')
      process.exit(1)
    }

    const { startCatalog } = require('../dist/cjs/catalog')

    function catalogFlag(name) {
      const idx = args.indexOf(name)
      return idx !== -1 ? args[idx + 1] : undefined
    }

    const port        = parseInt(catalogFlag('--port') ?? '4001', 10)
    const manifestArg = catalogFlag('--manifest')
    const registryArg = catalogFlag('--registry')

    if (isNaN(port) || port < 1 || port > 65535) {
      process.stderr.write('capman-mcp catalog start: --port must be a valid port number (1-65535)\n')
      process.exit(1)
    }

    const server = await startCatalog(port, {
      registryPath: registryArg,
      manifestPath: manifestArg,
    })

    const addr = server.address()
    process.stderr.write(`[capman-mcp] Catalog server running at http://localhost:${addr.port}\n`)
    process.stderr.write(`[capman-mcp] Endpoints:\n`)
    process.stderr.write(`[capman-mcp]   GET /health\n`)
    process.stderr.write(`[capman-mcp]   GET /capabilities\n`)
    process.stderr.write(`[capman-mcp]   GET /capabilities/:fqId\n`)
    process.stderr.write(`[capman-mcp]   GET /capabilities/:fqId/badge\n`)
    process.stderr.write(`[capman-mcp]   GET /capabilities/:fqId/impact\n`)

    // Keep the process alive — catalog runs until Ctrl+C
    await new Promise(() => {})
    return
  }

  process.stderr.write(`capman-mcp: unknown command "${command}"\n`)
  printUsage()
  process.exit(1)
}

main().catch(err => {
  process.stderr.write(`capman-mcp: fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
  if (process.env.DEBUG) process.stderr.write(err.stack + '\n')
  process.exit(1)
})
