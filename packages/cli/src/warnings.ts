import process from 'node:process'

/**
 * Node prints every process warning raised anywhere in the process — including
 * deprecations from third-party libraries — straight to stderr. flash-tunnel
 * owns its terminal output, so drop those deprecations and keep real warnings
 * (for example MaxListenersExceededWarning) readable.
 *
 * `--trace-deprecation` or `FLASH_TUNNEL_DEBUG=1` restores the raw output.
 */
export function installWarningFilter(): void {
  if (process.traceDeprecation || process.env.FLASH_TUNNEL_DEBUG) {
    return
  }

  // Node's default printer is itself a 'warning' listener and adding another
  // listener does not replace it, so the default one has to go.
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning') {
      return
    }
    process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`)
  })
}
