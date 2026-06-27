#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const archiver = require('archiver')

const ROOT = path.resolve(__dirname, '..')
const EXPORTS_DIR = path.join(ROOT, 'exports')
const OUT_FILE = path.join(EXPORTS_DIR, 'capman-mcp.zip')
const ZIPIGNORE_FILE = path.join(ROOT, '.zipignore')

function readZipignore () {
  if (!fs.existsSync(ZIPIGNORE_FILE)) return []
  return fs
    .readFileSync(ZIPIGNORE_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

function main () {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true })

  const excludePatterns = readZipignore()

  const output = fs.createWriteStream(OUT_FILE)
  const archive = archiver('zip', { zlib: { level: 9 } })

  archive.on('warning', err => {
    if (err.code !== 'ENOENT') throw err
    console.warn('[make-zip] warning:', err.message)
  })

  archive.on('error', err => { throw err })

  output.on('close', () => {
    const kb = (archive.pointer() / 1024).toFixed(1)
    console.log(`\n✓ capman-mcp.zip  ${kb} KB  →  exports/capman-mcp.zip`)
  })

  archive.pipe(output)

  archive.glob('**/*', {
    cwd: ROOT,
    dot: true,
    ignore: [
      'exports/**',
      ...excludePatterns,
    ],
  })

  archive.finalize()
}

main()
