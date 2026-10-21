import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkspaceCandidate {
  name: string
  cwd: string
  packageJson: string
}

function hasRunnableScript(scripts: Record<string, string> | undefined): boolean {
  return Boolean(scripts?.dev ?? scripts?.preview ?? scripts?.start)
}

/**
 * Find package.json files under apps/* or packages/* that can run a server.
 * Only used when the project root itself has nothing to run.
 */
export function detectWorkspaceCandidates(cwd: string): WorkspaceCandidate[] {
  const candidates: WorkspaceCandidate[] = []

  for (const root of ['apps', 'packages']) {
    const directory = join(cwd, root)
    if (!existsSync(directory)) {
      continue
    }

    let entries: string[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    }
    catch {
      continue
    }

    for (const entry of entries) {
      const packageJson = join(directory, entry, 'package.json')
      if (!existsSync(packageJson)) {
        continue
      }

      try {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as {
          name?: string
          scripts?: Record<string, string>
        }
        if (!hasRunnableScript(parsed.scripts)) {
          continue
        }
        candidates.push({
          name: parsed.name ?? entry,
          cwd: join(directory, entry),
          packageJson
        })
      }
      catch {
        // Ignore malformed package.json; detection reports it elsewhere.
      }
    }
  }

  return candidates.sort((a, b) => a.cwd.localeCompare(b.cwd))
}
