import * as fs from 'fs'
import type { InvocationLogEntry } from './types'

/**
 * Append-only invocation audit logger for capman-mcp.
 *
 * Writes one JSON line per tool invocation. Logs only param *names*,
 * never values — raw param values are PII and must not appear in logs.
 *
 * Default output: process.stderr
 * Optional: a file path for a persistent append-only log.
 */
export class InvocationLogger {
  private fileStream?: fs.WriteStream
  private readonly enabled: boolean
  private readonly demoMode: boolean

  constructor(opts?: { logFile?: string; enabled?: boolean; demoMode?: boolean }) {
    this.enabled = opts?.enabled !== false
    this.demoMode = opts?.demoMode ?? false
    if (this.enabled && opts?.logFile) {
      this.fileStream = fs.createWriteStream(opts.logFile, { flags: 'a', encoding: 'utf-8' })
      this.fileStream.on('error', err => {
        process.stderr.write(`[capman-mcp] logger write error: ${err.message}\n`)
      })
    }
  }

  logInvocation(entry: InvocationLogEntry): void {
    if (!this.enabled) return
    const line = this.demoMode
      ? this.formatEntry(entry) + '\n'
      : JSON.stringify(entry) + '\n'
    if (this.fileStream) {
      this.fileStream.write(line)
    } else {
      process.stderr.write(line)
    }
  }

  /**
   * Human-readable format for demo/CLI output.
   */
  formatEntry(entry: InvocationLogEntry): string {
    const verdict = entry.verdict !== 'clear' ? ` [${entry.verdict}]` : ''
    const dry = entry.dryRun ? ' (dry-run)' : ''
    const err = entry.error ? ` ERROR: ${entry.error}` : ''
    return (
      `${entry.ts} ${entry.capabilityId}${dry}${verdict} via=${entry.resolvedVia} ` +
      `${entry.durationMs}ms params=[${entry.params.join(', ')}]${err}`
    )
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.fileStream) {
        this.fileStream.end(() => resolve())
        this.fileStream.once('error', reject)
      } else {
        resolve()
      }
    })
  }
}
