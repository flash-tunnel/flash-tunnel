import type { PreviewSession } from '@flash-tunnel/core'
import type { TunnelMode } from '@flash-tunnel/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import { loadFlashTunnelConfig, startPreviewSession } from '@flash-tunnel/core'
import { cac } from 'cac'
import { theme } from './ui/theme'

interface StartOptions {
  cwd?: string
  port?: string
  command?: string
  url?: string
  mode?: string
  verbose?: boolean
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

type StopReason = 'SIGINT' | 'SIGTERM' | 'server-exit' | 'tunnel-exit'

function waitForStop(session: PreviewSession): Promise<StopReason> {
  return new Promise((resolveStop) => {
    let finish: (reason: StopReason) => void = (): void => {}

    const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => finish(signal)

    finish = (reason: StopReason): void => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolveStop(reason)
    }

    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    session.exited.then(() => finish('tunnel-exit'))
    session.server.exited?.then(() => finish('server-exit'))
  })
}

function parseMode(value: string | undefined): TunnelMode {
  if (!value) {
    return 'quick'
  }
  if (value === 'quick' || value === 'named') {
    return value
  }
  throw new Error(`Invalid tunnel mode "${value}". Use "quick" or "named".`)
}

async function startPreview(options: StartOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const { config, source } = await loadFlashTunnelConfig(cwd)

  if (source) {
    process.stdout.write(`${theme.dim('config')} ${source}\n`)
  }

  const provider = config.providers?.cloudflare as
    | { accountId?: string, cloudflaredPath?: string }
    | undefined

  const tunnel = createCloudflareTunnel({
    cloudflaredPath: process.env.FLASH_TUNNEL_CLOUDFLARED ?? provider?.cloudflaredPath,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? provider?.accountId,
    apiToken: process.env.CLOUDFLARE_API_TOKEN
  })

  const session = await startPreviewSession({
    cwd,
    config,
    adapters: { tunnel },
    mode: parseMode(options.mode),
    onLog: options.verbose
      ? line => process.stderr.write(`${theme.dim('[log]')} ${line}\n`)
      : undefined
  })

  process.stdout.write(`${theme.ok('✔')} local  ${theme.url(session.localUrl)}\n`)
  process.stdout.write(`${theme.ok('✔')} public ${theme.url(session.publicUrl)}\n`)
  process.stdout.write(`${theme.dim('Press Ctrl+C to stop.')}\n`)

  const reason = await waitForStop(session)

  if (reason === 'tunnel-exit') {
    process.stderr.write(`${theme.err('✖')} cloudflared exited unexpectedly\n`)
    process.exitCode = 5
  }
  else if (reason === 'server-exit') {
    process.stderr.write(`${theme.err('✖')} dev server exited unexpectedly\n`)
    process.exitCode = 3
  }
  else {
    process.stdout.write(`${theme.dim('Stopping...')}\n`)
  }

  await session.stop()
}

async function runStart(options: StartOptions = {}): Promise<void> {
  try {
    await startPreview(options)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${theme.err('✖')} ${message}\n`)
    process.exitCode = 1
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = cac('flash-tunnel')

  cli
    .command('[root]', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((options: StartOptions = {}) => runStart(options))

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
