import { sleep } from '@flash-tunnel/utils'

export interface VerifyPublicUrlOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  /** Query DNS-over-HTTPS when the HTTPS probe fails, for a useful error. */
  diagnoseDns?: boolean
}

interface DohAnswer {
  name?: string
  type?: number
  data?: string
}

async function dnsDiagnostic(hostname: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
      {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000)
      }
    )

    if (!response.ok) {
      return undefined
    }

    const body = await response.json() as { Answer?: DohAnswer[], Status?: number }
    const answers = body.Answer ?? []
    if (answers.length === 0) {
      return 'no CNAME answer yet'
    }

    return answers
      .slice(0, 3)
      .map(answer => `${answer.name ?? hostname} -> ${answer.data ?? '?'}`)
      .join(', ')
  }
  catch {
    return undefined
  }
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
  let detail = ''
  if (options.diagnoseDns) {
    const hostname = new URL(url).hostname
    const diagnostic = await dnsDiagnostic(hostname)
    if (diagnostic) {
      detail = `\nDNS diagnostic: ${diagnostic}`
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${reason}${detail}`)
}
