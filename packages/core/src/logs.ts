import type { WriteStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from '@flash-tunnel/utils'
import { projectStateDirectory } from './state/store'

export type SessionLogKind = 'server' | 'tunnel'

export interface SessionLog {
  path: string
  write: (line: string) => void
  close: () => Promise<void>
}

function logsDirectory(projectRoot: string): string {
  return join(projectStateDirectory(projectRoot), 'logs')
}

export function sessionLogPath(
  projectRoot: string,
  sessionId: string,
  kind: SessionLogKind
): string {
  return join(logsDirectory(projectRoot), `${kind}-${sessionId}.log`)
}

export async function createSessionLog(
  projectRoot: string,
  sessionId: string,
  kind: SessionLogKind
): Promise<SessionLog> {
  const directory = logsDirectory(projectRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => {})

  const path = sessionLogPath(projectRoot, sessionId, kind)
  const stream: WriteStream = createWriteStream(path, { flags: 'a', mode: 0o600 })
  stream.on('error', () => {})

  return {
    path,
    write: (line: string) => {
      stream.write(`${new Date().toISOString()} ${redact(line)}\n`)
    },
    close: () => new Promise<void>((resolveClose) => {
      stream.end(() => resolveClose())
    })
  }
}

/** Keep the newest N session logs, delete older server/tunnel pairs. */
export async function pruneSessionLogs(projectRoot: string, keep = 10): Promise<string[]> {
  const directory = logsDirectory(projectRoot)

  let files: string[]
  try {
    files = (await readdir(directory)).filter(file => /^(?:server|tunnel)-.+\.log$/.test(file))
  }
  catch {
    return []
  }

  const sessions = new Map<string, Array<{ file: string, mtimeMs: number }>>()
  for (const file of files) {
    const match = /^(?:server|tunnel)-(.+)\.log$/.exec(file)
    if (!match?.[1]) {
      continue
    }

    let mtimeMs = 0
    try {
      mtimeMs = (await stat(join(directory, file))).mtimeMs
    }
    catch {
      continue
    }

    const entries = sessions.get(match[1]) ?? []
    entries.push({ file, mtimeMs })
    sessions.set(match[1], entries)
  }

  const ordered = [...sessions.entries()]
    .map(([sessionId, entries]) => ({
      sessionId,
      latest: Math.max(...entries.map(entry => entry.mtimeMs))
    }))
    .sort((a, b) => b.latest - a.latest)

  const removed: string[] = []
  for (const entry of ordered.slice(keep)) {
    for (const file of sessions.get(entry.sessionId) ?? []) {
      await rm(join(directory, file.file), { force: true }).catch(() => {})
      removed.push(file.file)
    }
  }

  return removed
}
