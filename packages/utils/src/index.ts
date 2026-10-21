import { randomBytes } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'

const RANDOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export function stripAnsi(input: string): string {
  return stripVTControlCharacters(input)
}

/** Remove credentials from log lines before they reach a file or terminal. */
export function redact(input: string): string {
  return input
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(TUNNEL_TOKEN\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|api[_-]?token|token|secret)["']?\s*[:=]\s*["']?)[\w.~+/=-]{8,}/gi, '$1[REDACTED]')
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)

    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function randomId(length = 4): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('randomId length must be a positive integer')
  }

  const bytes = randomBytes(length)
  let value = ''
  for (const byte of bytes) {
    value += RANDOM_ALPHABET.charAt(byte % RANDOM_ALPHABET.length)
  }
  return value
}

export function slugify(input: string, maxLength = 24): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/g, '')

  return slug || 'app'
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('duration must be a non-negative number')
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`
  }

  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1000
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
  }

  if (milliseconds >= 3_600_000) {
    const hours = Math.floor(milliseconds / 3_600_000)
    const minutes = Math.round((milliseconds % 3_600_000) / 60_000)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }

  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 1000) {
      throw new RangeError('duration must be at least 1000ms')
    }
    return Math.floor(input)
  }

  const match = /^(\d+(?:\.\d+)?)(ms|[smh])$/.exec(input.trim())
  if (!match) {
    throw new RangeError(`invalid duration: ${input}`)
  }

  const value = Number(match[1] ?? '0')
  const unit = match[2] ?? 'ms'
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  const milliseconds = Math.floor(value * multiplier)

  if (milliseconds < 1000) {
    throw new RangeError('duration must be at least 1000ms')
  }

  return milliseconds
}
