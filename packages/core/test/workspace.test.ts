import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectWorkspaceCandidates } from '../src'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flash-tunnel-workspace-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function writePackage(path: string, content: unknown): Promise<void> {
  await mkdir(join(cwd, path), { recursive: true })
  await writeFile(join(cwd, path, 'package.json'), JSON.stringify(content))
}

describe('detectWorkspaceCandidates', () => {
  it('finds runnable apps and packages', async () => {
    await writePackage('apps/web', { name: 'web', scripts: { dev: 'vite' } })
    await writePackage('packages/lib', { name: 'lib' })
    await writePackage('packages/ui', { name: 'ui', scripts: { start: 'node server.mjs' } })

    const candidates = detectWorkspaceCandidates(cwd)
    expect(candidates.map(candidate => candidate.name)).toEqual(['web', 'ui'])
  })

  it('returns nothing without workspace packages', async () => {
    expect(detectWorkspaceCandidates(cwd)).toEqual([])
  })
})
