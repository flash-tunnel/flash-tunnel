import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionLog, projectStateDirectory, pruneSessionLogs, sessionLogPath } from '../src'

let home: string
let project: string
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.FLASH_TUNNEL_HOME
  home = await mkdtemp(join(tmpdir(), 'flash-tunnel-home-'))
  project = await mkdtemp(join(tmpdir(), 'flash-tunnel-logs-'))
  process.env.FLASH_TUNNEL_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('session logs', () => {
  it('writes a log with a timestamp outside the project', async () => {
    const log = await createSessionLog(project, 'ft_logs_1', 'server')
    log.write('server ready')
    await log.close()

    const content = await readFile(log.path, 'utf8')
    expect(content).toContain('server ready')
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(log.path.startsWith(project)).toBe(false)
    expect(log.path.startsWith(home)).toBe(true)
  })

  it('prunes older session log pairs', async () => {
    const directory = join(projectStateDirectory(project), 'logs')
    await mkdir(directory, { recursive: true })

    for (let index = 0; index < 4; index += 1) {
      const sessionId = `ft_old_${index}`
      const timestamp = new Date(Date.now() - (4 - index) * 60_000)
      for (const kind of ['server', 'tunnel'] as const) {
        const file = sessionLogPath(project, sessionId, kind)
        await writeFile(file, `${kind}\n`)
        await utimes(file, timestamp, timestamp)
      }
    }

    const removed = await pruneSessionLogs(project, 2)

    expect(removed).toHaveLength(4)
    expect(removed.some(file => file.includes('ft_old_0'))).toBe(true)
    expect(removed.some(file => file.includes('ft_old_3'))).toBe(false)
  })
})
