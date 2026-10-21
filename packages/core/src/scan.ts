import type { SessionState } from './state/store'
import { isSessionStale, listSessionStates } from './state/store'

export interface StaleSessions {
  /** Dead sessions that belong to the project being started. */
  project: SessionState[]
  /** Dead sessions from other projects: report, never auto-clean. */
  others: SessionState[]
}

export function sameProject(state: SessionState, projectRoot: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').toLowerCase()
  return normalize(state.projectRoot) === normalize(projectRoot)
}

export async function findStaleSessions(
  projectRoot: string,
  now: number = Date.now()
): Promise<StaleSessions> {
  const states = await listSessionStates()
  // --keep sessions are intentional leftovers; only an explicit clean removes them.
  const stale = states.filter(state => !state.cleanup.kept && isSessionStale(state, now))

  return {
    project: stale.filter(state => sameProject(state, projectRoot)),
    others: stale.filter(state => !sameProject(state, projectRoot))
  }
}
