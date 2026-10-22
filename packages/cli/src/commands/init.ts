import type { Reporter } from '../ui/reporter'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { symbols } from '../ui/symbols'
import { theme } from '../ui/theme'

const CONFIG_TEMPLATE = `import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  // domain: { zone: 'example.com', subdomain: '{project}-{rand}' },
  // server: { command: 'pnpm dev', port: 5173 },
  // tunnel: { mode: 'named' },
  // autoStopAfter: '2h',
})
`

export interface InitOptions {
  cwd?: string
  force?: boolean
}

export async function runInit(options: InitOptions, reporter: Reporter): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const configFile = join(cwd, 'flash-tunnel.ts')

  const configExists = existsSync(configFile)
  if (configExists && !options.force) {
    throw new Error('flash-tunnel.ts already exists; pass --force to overwrite')
  }

  await writeFile(configFile, CONFIG_TEMPLATE)

  reporter.event({
    type: 'init',
    configFile
  })

  if (reporter.json) {
    return
  }

  reporter.human(`${theme.ok(symbols.ok)} config    ${configFile}\n`)
  reporter.human(`\n${theme.dim('Next: edit flash-tunnel.ts, then run npx flash-tunnel')}\n`)
}
