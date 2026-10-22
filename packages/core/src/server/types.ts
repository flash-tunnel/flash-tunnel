export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

export type Framework
  = | 'angular'
    | 'astro'
    | 'cra'
    | 'next'
    | 'nuxt'
    | 'storybook'
    | 'sveltekit'
    | 'umi'
    | 'vite'
    | 'vue-cli'
    | 'unknown'

export interface ServerPlan {
  mode: 'attach' | 'command' | 'static'
  cwd: string
  command?: string
  script?: string
  packageManager?: PackageManager
  framework: Framework
  port: number
  url?: string
  dir?: string
  reason: string
  confidence: 'high' | 'low'
}

export interface ServerHandle {
  plan: ServerPlan
  url: string
  port: number
  pid?: number
  startedByUs: boolean
  output: string[]
  /** Resolves when a process-backed server exits (static/attach have no exit). */
  exited?: Promise<void>
  stop: () => Promise<void>
}

export interface StartServerOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Extra environment for the spawned dev server, merged over process.env. */
  env?: NodeJS.ProcessEnv
}
