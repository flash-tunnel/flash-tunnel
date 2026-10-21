import { sleep } from '@flash-tunnel/utils'

export interface VerifyPublicUrlOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
}

export async function verifyPublicUrl(
  url: string,
  options: VerifyPublicUrlOptions = {}
): Promise<{ status: number, url: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 1000
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      })

      if (response.status < 500) {
        return { status: response.status, url }
      }

      lastError = new Error(`HTTP ${response.status}`)
    }
    catch (error) {
      lastError = error
    }

    await sleep(intervalMs, options.signal)
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'no response')
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${reason}`)
}
