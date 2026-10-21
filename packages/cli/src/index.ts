import type { ServerHandle } from '@flash-tunnel/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { detectServer, loadFlashTunnelConfig, startServer } from '@flash-tunnel/core'
import { cac } from 'cac'
import { theme } from './ui/theme'

interface StartOptions {
  cwd?: string
  port?: string
  command?: string
  url?: string
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

type StopReason = 'exit' | 'SIGINT' | 'SIGTERM'

function waitForStop(handle: ServerHandle): Promise<StopReason> {
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
    handle.exited?.then(() => finish('exit'))
  })
}

async function startPreview(options: StartOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const { config, source } = await loadFlashTunnelConfig(cwd)

  if (source) {
    process.stdout.write(`${theme.dim('config')} ${source}\n`)
  }

  const overrides = { ...config.server }
  if (options.port !== undefined) {
    overrides.port = Number(options.port)
  }
  if (options.command) {
    overrides.command = options.command
  }
  if (options.url) {
    overrides.url = options.url
  }

  const plan = detectServer(cwd, overrides)
  const target = plan.mode === 'static' ? plan.dir : plan.command
  process.stdout.write(`${theme.ok('✔')} ${theme.dim(plan.reason)} ${target ?? ''}\n`)

  const handle = await startServer(plan, {
    timeoutMs: overrides.timeout ?? 60_000,
    onLog: (line) => {
      process.stderr.write(`${theme.dim('[web]')} ${line}\n`)
    }
  })

  process.stdout.write(`${theme.ok('✔')} local ${theme.url(handle.url)} ${theme.dim(handle.startedByUs ? '(started)' : '(reused)')}\n`)
  process.stdout.write(`${theme.dim('Tunnel orchestration is not implemented yet; press Ctrl+C to stop.')}\n`)

  const reason = await waitForStop(handle)

  if (reason === 'exit') {
    process.stderr.write(`${theme.err('✖')} dev server exited unexpectedly\n`)
    process.exitCode = 3
  }
  else {
    process.stdout.write(`${theme.dim('Stopping...')}\n`)
  }

  await handle.stop()
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
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .action((options: StartOptions = {}) => runStart(options))

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
