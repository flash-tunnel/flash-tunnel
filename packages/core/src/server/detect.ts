import type { ServerConfig } from '@flash-tunnel/config'
import type { Framework, PackageManager, ServerPlan } from './types'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

function detectPackageManager(cwd: string, pkg: PackageJson | undefined): PackageManager {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared === 'bun' || declared === 'npm' || declared === 'pnpm' || declared === 'yarn') {
    return declared
  }

  for (const [lockfile, manager] of PACKAGE_MANAGER_BY_LOCKFILE) {
    if (existsSync(join(cwd, lockfile))) {
      return manager
    }
  }

  return 'npm'
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

function hasBuildOutput(cwd: string, framework: Framework): boolean {
  if (framework === 'next') {
    return existsSync(join(cwd, '.next'))
  }

  if (framework === 'nuxt') {
    return existsSync(join(cwd, '.output')) || existsSync(join(cwd, '.nuxt'))
  }

  return BUILD_DIRECTORIES.some((directory) => {
    const index = join(cwd, directory, 'index.html')
    return existsSync(index) && statSync(index).isFile()
  })
}

function findStaticDirectory(cwd: string): string | undefined {
  return BUILD_DIRECTORIES.find((directory) => {
    const index = join(cwd, directory, 'index.html')
    return existsSync(index) && statSync(index).isFile()
  })
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

export function detectServer(cwd: string, overrides: ServerConfig = {}): ServerPlan {
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
    return {
      mode: 'attach',
      cwd: workingDirectory,
      url: overrides.url,
      framework: 'unknown',
      port: overrides.port ?? Number(new URL(overrides.url).port || 80),
      reason: 'server.url is configured',
      confidence: 'high'
    }
  }

  if (overrides.dir) {
    return {
      mode: 'static',
      cwd: workingDirectory,
      dir: resolve(workingDirectory, overrides.dir),
      framework: 'unknown',
      port: overrides.port ?? 4173,
      reason: 'server.dir is configured',
      confidence: 'high'
    }
  }

  const pkg = readPackageJson(workingDirectory)
  const packageManager = detectPackageManager(workingDirectory, pkg)
  const frameworkDefinition = detectFramework(pkg)
  const framework = frameworkDefinition?.name ?? 'unknown'
  const scripts = pkg?.scripts ?? {}
  const hasOutput = hasBuildOutput(workingDirectory, framework)

  if (scripts.preview && hasOutput) {
    return {
      mode: 'command',
      cwd: workingDirectory,
      command: createCommand(packageManager, 'preview'),
      script: 'preview',
      packageManager,
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

  if (scripts.preview && !scripts.dev && !hasOutput) {
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
      framework,
      port: overrides.port
        ?? parsePortFromScript(scripts.start)
        ?? frameworkDefinition?.previewPort
        ?? 3000,
      reason: 'start script',
      confidence: 'low'
    }
  }

  const staticDirectory = findStaticDirectory(workingDirectory)
  if (staticDirectory) {
    return {
      mode: 'static',
      cwd: workingDirectory,
      dir: join(workingDirectory, staticDirectory),
      framework,
      port: overrides.port ?? 4173,
      reason: `static build output in ${staticDirectory}/`,
      confidence: 'high'
    }
  }

  throw new Error(
    'No runnable script found. Set server.command in flash-tunnel.ts (for example "pnpm dev"), or build the project to a dist/ directory.'
  )
}
