import { readFileSync } from 'node:fs'
import process from 'node:process'
import { cac } from 'cac'

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

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = cac('flash-tunnel')

  cli
    .command('[root]', 'Start a temporary public preview')
    .action(() => {
      process.stdout.write('flash-tunnel M0 scaffold: preview orchestration is not implemented yet.\n')
    })

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
