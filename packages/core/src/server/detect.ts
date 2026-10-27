import type { ServerConfig } from '@flash-tunnel/config'
import type { Framework, PackageManager, ServerPlan } from './types'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FlashTunnelError } from '../errors'

interface FrameworkDefinition {
  name: Framework
  dependencies: string[]
  devPort: number
  previewPort: number
}

const FRAMEWORKS: FrameworkDefinition[] = [
  { name: 'next', dependencies: ['next'], devPort: 3000, previewPort: 3000 },
  { name: 'nuxt', dependencies: ['nuxt'], devPort: 3000, previewPort: 3000 },
  { name: 'astro', dependencies: ['astro'], devPort: 4321, previewPort: 4321 },
  { name: 'sveltekit', dependencies: ['@sveltejs/kit'], devPort: 5173, previewPort: 4173 },
  { name: 'vue-cli', dependencies: ['@vue/cli-service'], devPort: 8080, previewPort: 8080 },
  { name: 'cra', dependencies: ['react-scripts'], devPort: 3000, previewPort: 3000 },
  { name: 'angular', dependencies: ['@angular/cli'], devPort: 4200, previewPort: 4200 },
  { name: 'storybook', dependencies: ['storybook'], devPort: 6006, previewPort: 6006 },
  { name: 'umi', dependencies: ['umi'], devPort: 8000, previewPort: 8000 },
  { name: 'vite', dependencies: ['vite'], devPort: 5173, previewPort: 4173 }
]

const BUILD_DIRECTORIES = ['dist', 'build', 'out']

const PACKAGE_MANAGER_BY_LOCKFILE: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm']
]

interface PackageJson {
  name?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: unknown
}

function readPackageJson(cwd: string): PackageJson | undefined {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) {
    return undefined
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
  }
  catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function detectPackageManager(cwd: string, pkg: PackageJson | undefined): {
  manager: PackageManager
  source?: string
} {
  let directory = resolve(cwd)
  let currentPackage = pkg

  while (true) {
    const declared = currentPackage?.packageManager?.split('@')[0]
    if (declared === 'bun' || declared === 'npm' || declared === 'pnpm' || declared === 'yarn') {
      return { manager: declared, source: join(directory, 'package.json') }
    }

    for (const [lockfile, manager] of PACKAGE_MANAGER_BY_LOCKFILE) {
      const source = join(directory, lockfile)
      if (existsSync(source)) {
        return { manager, source }
      }
    }

    const parent = dirname(directory)
    if (parent === directory || existsSync(join(directory, '.git'))
      || existsSync(join(directory, 'pnpm-workspace.yaml')) || currentPackage?.workspaces) {
      break
    }
    directory = parent
    currentPackage = readPackageJson(directory)
  }

  return { manager: 'npm' }
}

/**
 * Package manager for a directory, preferring the `packageManager` field and
 * falling back to lockfiles in each directory up to the Git or workspace root.
 * Detection and `--build` share it so they select the same manager.
 */
export function packageManagerFor(cwd: string): PackageManager {
  return detectPackageManager(cwd, readPackageJson(cwd)).manager
}

function detectFramework(pkg: PackageJson | undefined): FrameworkDefinition | undefined {
  if (!pkg) {
    return undefined
  }

  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies
  }

  return FRAMEWORKS.find(framework =>
    framework.dependencies.some(dependency => dependency in dependencies)
  )
}

function findIndexDirectory(cwd: string): string | undefined {
  return BUILD_DIRECTORIES.find((directory) => {
    const index = join(cwd, directory, 'index.html')
    // throwIfNoEntry keeps a file that disappears between calls from crashing detection.
    return statSync(index, { throwIfNoEntry: false })?.isFile() ?? false
  })
}

function hasBuildOutput(cwd: string, framework: Framework): boolean {
  if (framework === 'next') {
    return existsSync(join(cwd, '.next'))
  }

  if (framework === 'nuxt') {
    return existsSync(join(cwd, '.output')) || existsSync(join(cwd, '.nuxt'))
  }

  return findIndexDirectory(cwd) !== undefined
}

function parsePortFromScript(script: string | undefined): number | undefined {
  if (!script) {
    return undefined
  }

  const patterns = [
    /--port[=\s]+(\d+)/,
    /-p\s+(\d+)/,
    /PORT=(\d+)/
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(script)
    if (match?.[1]) {
      return Number(match[1])
    }
  }

  return undefined
}

function createCommand(manager: PackageManager, script: string): string {
  return `${manager} run ${script}`
}

function staticPlan(
  cwd: string,
  dir: string,
  port: number,
  framework: Framework,
  reason: string
): ServerPlan {
  return {
    mode: 'static',
    cwd,
    dir,
    framework,
    port,
    reason,
    confidence: 'high'
  }
}

export interface DetectServerOptions {
  /** Skip the preview script even when build output exists. */
  forceDev?: boolean
  /** Ignore package scripts and serve a static directory. */
  forceStatic?: boolean
}

export function detectServer(
  cwd: string,
  overrides: ServerConfig = {},
  options: DetectServerOptions = {}
): ServerPlan {
  const baseDirectory = resolve(cwd)
  const workingDirectory = overrides.cwd ? resolve(baseDirectory, overrides.cwd) : baseDirectory

  if (overrides.command) {
    return {
      mode: 'command',
      cwd: workingDirectory,
      command: overrides.command,
      framework: 'unknown',
      port: overrides.port ?? 3000,
      reason: 'server.command is configured',
      confidence: 'high'
    }
  }

  if (overrides.url) {
    const url = new URL(overrides.url)
    const defaultPort = url.protocol === 'https:' ? 443 : 80
    return {
      mode: 'attach',
      cwd: workingDirectory,
      url: overrides.url,
      framework: 'unknown',
      port: overrides.port ?? Number(url.port || defaultPort),
      reason: 'server.url is configured',
      confidence: 'high'
    }
  }

  if (overrides.dir) {
    return staticPlan(
      workingDirectory,
      resolve(workingDirectory, overrides.dir),
      overrides.port ?? 4173,
      'unknown',
      'server.dir is configured'
    )
  }

  if (options.forceStatic) {
    const staticDirectory = findIndexDirectory(workingDirectory)
    if (!staticDirectory) {
      throw new Error(
        'No static directory found. Build the project or pass --static <dir> with an index.html.'
      )
    }
    return staticPlan(
      workingDirectory,
      join(workingDirectory, staticDirectory),
      overrides.port ?? 4173,
      'unknown',
      `static mode forced (${staticDirectory}/)`
    )
  }

  const pkg = readPackageJson(workingDirectory)
  const { manager: packageManager, source: packageManagerSource } = detectPackageManager(workingDirectory, pkg)
  const frameworkDefinition = detectFramework(pkg)
  const framework = frameworkDefinition?.name ?? 'unknown'
  const scripts = pkg?.scripts ?? {}
  const hasOutput = hasBuildOutput(workingDirectory, framework)

  if (!options.forceDev && scripts.preview && hasOutput) {
    return {
      mode: 'command',
      cwd: workingDirectory,
      command: createCommand(packageManager, 'preview'),
      script: 'preview',
      packageManager,
      packageManagerSource,
      framework,
      port: overrides.port
        ?? parsePortFromScript(scripts.preview)
        ?? frameworkDefinition?.previewPort
        ?? 4173,
      reason: frameworkDefinition
        ? `preview script with build output (${framework})`
        : 'preview script with build output',
      confidence: 'high'
    }
  }

  if (!options.forceDev && scripts.preview && !scripts.dev && !hasOutput) {
    throw new Error(
      'Found a preview script but no build output. Run the build first, or use --dev if a dev script exists.'
    )
  }

  if (scripts.dev) {
    return {
      mode: 'command',
      cwd: workingDirectory,
      command: createCommand(packageManager, 'dev'),
      script: 'dev',
      packageManager,
      packageManagerSource,
      framework,
      port: overrides.port
        ?? parsePortFromScript(scripts.dev)
        ?? frameworkDefinition?.devPort
        ?? 3000,
      reason: scripts.preview
        ? 'preview build output missing, fell back to dev'
        : 'dev script',
      confidence: frameworkDefinition ? 'high' : 'low'
    }
  }

  if (scripts.start) {
    return {
      mode: 'command',
      cwd: workingDirectory,
      command: createCommand(packageManager, 'start'),
      script: 'start',
      packageManager,
      packageManagerSource,
      framework,
      port: overrides.port
        ?? parsePortFromScript(scripts.start)
        ?? frameworkDefinition?.previewPort
        ?? 3000,
      reason: 'start script',
      confidence: 'low'
    }
  }

  const staticDirectory = findIndexDirectory(workingDirectory)
  if (staticDirectory) {
    return staticPlan(
      workingDirectory,
      join(workingDirectory, staticDirectory),
      overrides.port ?? 4173,
      framework,
      `static build output in ${staticDirectory}/`
    )
  }

  throw new FlashTunnelError('No runnable script found', {
    code: 'NO_RUNNABLE_SCRIPT',
    exitCode: 3,
    hint: 'Set server.command in flash-tunnel.ts (for example "pnpm dev"), or build the project to a dist/ directory.'
  })
}
