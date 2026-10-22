import type { Reporter } from '../ui/reporter'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { FlashTunnelError } from '@flash-tunnel/core'
import { shellInvocation } from '@flash-tunnel/utils'
import { theme } from '../ui/theme'

export function packageManagerFor(cwd: string): string {
  const candidates: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm']
  ]
  return candidates.find(([lockfile]) => existsSync(join(cwd, lockfile)))?.[1] ?? 'npm'
}

export function runBuildScript(cwd: string, reporter: Reporter): void {
  const packageJson = join(cwd, 'package.json')
  if (!existsSync(packageJson)) {
    throw new FlashTunnelError(`No package.json found in ${cwd}`, {
      code: 'BUILD_FAILED',
      exitCode: 3,
      hint: '--build needs a package.json with a build script'
    })
  }

  let parsed: { scripts?: Record<string, string> }
  try {
    parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { scripts?: Record<string, string> }
  }
  catch (error) {
    throw new FlashTunnelError(
      `Cannot read ${packageJson}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'BUILD_FAILED', exitCode: 3, cause: error }
    )
  }

  if (!parsed.scripts?.build) {
    throw new FlashTunnelError('No build script found in package.json', {
      code: 'BUILD_FAILED',
      exitCode: 3,
      hint: 'Remove --build, or add a "build" script'
    })
  }

  const manager = packageManagerFor(cwd)
  reporter.log(`${theme.dim('build')} ${manager} run build\n`)

  const invocation = shellInvocation(manager, ['run', 'build'])
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    shell: invocation.shell,
    windowsHide: true,
    env: { ...process.env, FLASH_TUNNEL: '1' }
  })

  if (result.stdout) {
    reporter.log(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  if (result.error || result.status !== 0) {
    throw new FlashTunnelError(
      `Build failed (exit code ${result.status ?? 'unknown'})`,
      { code: 'BUILD_FAILED', exitCode: 3, hint: 'Fix the build errors and retry', cause: result.error }
    )
  }
}

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => {
      server.close(() => resolvePort(true))
    })
    server.listen(port, '127.0.0.1')
    server.unref()
  })
}
