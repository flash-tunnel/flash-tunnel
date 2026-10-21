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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorExitCode(error: unknown): number {
  if (error instanceof FlashTunnelError) {
    return error.exitCode
  }
  return 1
}
