import { randomBytes } from 'node:crypto'

const RANDOM_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

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
