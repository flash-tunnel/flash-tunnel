import { AdapterError } from '@flash-tunnel/types'
import { ProjectLockedError } from './state/store'

export interface FlashTunnelErrorOptions {
  code: string
  exitCode?: number
  hint?: string
  cause?: unknown
}

/** Error with a stable code, user hint and process exit code. */
export class FlashTunnelError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly hint?: string

  constructor(message: string, options: FlashTunnelErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'FlashTunnelError'
    this.code = options.code
    this.exitCode = options.exitCode ?? 1
    this.hint = options.hint
  }
}

/**
 * Adapter error code prefixes mapped to the documented CLI exit codes.
 * Keep this table in sync with 07-cli.md.
 */
const ADAPTER_EXIT_CODES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:AUTH|TOKEN|PERMISSION|ACCOUNT)/, 4],
  [/^(?:DNS|ZONE|RECORD)/, 6],
  [/^TUNNEL/, 5],
  [/^(?:PUBLIC|VERIFY)/, 7]
]

export function adapterExitCode(code: string): number {
  return ADAPTER_EXIT_CODES.find(([pattern]) => pattern.test(code))?.[1] ?? 1
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorHint(error: unknown): string | undefined {
  if (error instanceof FlashTunnelError) {
    return error.hint
  }
  if (error instanceof AdapterError) {
    return error.hint
  }
  return undefined
}

export function errorExitCode(error: unknown): number {
  if (error instanceof FlashTunnelError) {
    return error.exitCode
  }
  if (error instanceof AdapterError) {
    return adapterExitCode(error.code)
  }
  if (error instanceof ProjectLockedError) {
    return 2
  }
  return 1
}
