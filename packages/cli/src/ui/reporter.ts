import type { ReadyPayload } from './types'
import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { themeStderr } from './theme'

export interface ReporterOptions {
  json?: boolean
  silent?: boolean
  verbose?: boolean
  cwd?: string
  readyFile?: string
  onReady?: string
}

/**
 * Single output gate:
 * - human mode writes to stdout,
 * - --json writes NDJSON to stdout and keeps human noise on stderr,
 * - --silent only allows errors and machine events.
 */
export class Reporter {
  readonly json: boolean
  readonly silent: boolean
  readonly verbose: boolean

  private readonly cwd: string
  private readonly readyFile?: string
  private readonly onReady?: string
  private readyPayload?: ReadyPayload

  constructor(options: ReporterOptions = {}) {
    this.json = options.json ?? false
    this.silent = options.silent ?? false
    this.verbose = options.verbose ?? false
    this.cwd = options.cwd ?? process.cwd()
    this.readyFile = options.readyFile
    this.onReady = options.onReady
  }

  human(message: string): void {
    if (!this.silent && !this.json) {
      process.stdout.write(message)
    }
  }

  /** Progress configured for humans; stderr in JSON mode so stdout stays NDJSON. */
  log(message: string): void {
    if (this.silent && !this.verbose) {
      return
    }
    const stream = this.json ? process.stderr : process.stdout
    stream.write(message)
  }

  warn(message: string): void {
    process.stderr.write(`${themeStderr.warn('!')} ${message}\n`)
  }

  event(value: Record<string, unknown>): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify(value)}\n`)
    }
  }

  async ready(payload: ReadyPayload): Promise<void> {
    this.readyPayload = payload
    this.event({ ...payload })

    if (this.readyFile) {
      const target = resolve(this.cwd, this.readyFile)
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, target)
    }

    if (this.onReady) {
      this.runOnReady(payload)
    }
  }

  error(error: unknown, code?: string, hint?: string): void {
    const message = error instanceof Error ? error.message : String(error)
    const effectiveCode = code ?? (error as { code?: string } | undefined)?.code

    if (this.json) {
      this.event({
        type: 'error',
        ...(effectiveCode ? { code: effectiveCode } : {}),
        message,
        ...(hint ? { hint } : {})
      })
      return
    }

    const codeSuffix = effectiveCode ? ` ${themeStderr.dim(`[${effectiveCode}]`)}` : ''
    process.stderr.write(`${themeStderr.err('✖')} ${message}${codeSuffix}\n`)
    if (hint) {
      process.stderr.write(`  ${themeStderr.dim('hint')} ${hint}\n`)
    }
  }

  get readyInfo(): ReadyPayload | undefined {
    return this.readyPayload
  }

  exit(code: number): void {
    this.event({ type: 'exit', code })
  }

  private runOnReady(payload: ReadyPayload): void {
    const child = spawn(this.onReady as string, {
      cwd: this.cwd,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        FLASH_TUNNEL_URL: payload.url,
        FLASH_TUNNEL_LOCAL_URL: payload.localUrl,
        FLASH_TUNNEL_SESSION_ID: payload.sessionId,
        FLASH_TUNNEL_TUNNEL_ID: payload.tunnelId,
        ...(payload.hostname ? { FLASH_TUNNEL_HOSTNAME: payload.hostname } : {}),
        ...(payload.expiresAt ? { FLASH_TUNNEL_EXPIRES_AT: payload.expiresAt } : {})
      }
    })

    child.once('error', (error) => {
      process.stderr.write(`${themeStderr.warn('!')} --on-ready failed: ${error.message}\n`)
    })
    child.unref()
  }
}
