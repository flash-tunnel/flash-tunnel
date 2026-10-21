import type { FlashTunnelEvents } from '@flash-tunnel/types'
import type { Spinner } from 'yocto-spinner'
import type { Reporter } from './reporter'
import process from 'node:process'
import { formatDuration } from '@flash-tunnel/utils'
import yoctoSpinner from 'yocto-spinner'
import { symbols } from './symbols'
import { theme } from './theme'

const LABELS: Record<string, string> = {
  server: 'local server',
  tunnel: 'tunnel',
  dns: 'domain',
  verify: 'verify'
}

export interface StepUiOptions {
  enabled?: boolean
}

/**
 * Renders core step events as spinner lines. The spinner itself never owns
 * signals: cleanup and exit codes stay with the CLI.
 */
export class StepUi {
  private readonly enabled: boolean
  private readonly startedAt = new Map<string, number>()
  private spinner: Spinner | undefined

  constructor(private readonly reporter: Reporter, options: StepUiOptions = {}) {
    this.enabled = options.enabled ?? (
      Boolean(process.stdout.isTTY)
      && !reporter.json
      && !reporter.silent
      && !reporter.verbose
    )
  }

  handle(event: FlashTunnelEvents['step']): void {
    this.reporter.event({ type: 'step', ...event })

    const label = LABELS[event.id] ?? event.id

    if (event.status === 'start') {
      this.startedAt.set(event.id, Date.now())
      this.start(label)
      return
    }

    const startedAt = this.startedAt.get(event.id) ?? Date.now()
    const duration = event.durationMs ?? Date.now() - startedAt
    const text = `${label}${event.detail ? `  ${event.detail}` : ''}`
    this.finish(event.status === 'ok', text, duration)
  }

  stop(): void {
    this.spinner?.stop()
    this.spinner = undefined
  }

  private start(label: string): void {
    if (!this.enabled) {
      return
    }
    this.spinner?.stop()
    this.spinner = yoctoSpinner({
      text: label,
      color: 'cyan',
      stream: process.stdout,
      handleSignals: false
    }).start()
  }

  private finish(ok: boolean, text: string, duration: number): void {
    const suffix = theme.dim(formatDuration(duration))

    if (this.enabled && this.spinner) {
      const line = `${text}  ${suffix}`
      if (ok) {
        this.spinner.success(line)
      }
      else {
        this.spinner.error(line)
      }
      this.spinner = undefined
      return
    }

    if (this.reporter.json) {
      return
    }

    const symbol = ok ? theme.ok(symbols.ok) : theme.err(symbols.fail)
    this.reporter.log(`${symbol} ${text}  ${suffix}\n`)
  }
}
