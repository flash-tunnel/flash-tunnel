# 11 · Monorepo 与工程化

基础配置直接对齐现有仓库：`ext-kit`（ESLint/antfu、simple-git-hooks + nano-staged、unbuild、vitest、pnpm 12）、`initx`（CLI 包布局、`bin` 包装、`stub` 开发）、`frp-bridge`（CLI/core/types 拆分、`type: 'lib'` 的 ESLint 配置）、`synra-monorepo`（unconfig、严格 tsconfig）。差异点集中在「CLI 发布形态」与「适配器作为可选依赖」。

## 目录结构

```text
flash-tunnel/
├─ .github/
│  └─ workflows/
│     └─ release.yaml            # 唯一 workflow，仅 tag v* 触发
├─ ai-docs/
│  └─ design-docs/                 # 本目录
├─ packages/
│  ├─ flash-tunnel/                # 用户门面：bin + 配置重导出
│  │  ├─ bin/flash-tunnel.mjs
│  │  ├─ src/index.ts
│  │  ├─ src/config.ts
│  │  ├─ package.json
│  │  └─ build.config.ts
│  ├─ cli/                         # @flash-tunnel/cli：命令/UI/信号
│  │  ├─ src/index.ts
│  │  ├─ src/commands/
│  │  ├─ src/ui/
│  │  ├─ src/builtins.ts
│  │  ├─ package.json
│  │  └─ build.config.ts
│  ├─ config/                      # @flash-tunnel/config：defineConfig + 类型
│  │  ├─ src/index.ts
│  │  ├─ package.json
│  │  └─ build.config.ts
│  ├─ core/
│  ├─ types/
│  ├─ utils/
│  └─ adapter-cloudflare/
├─ scripts/
│  └─ build.common.ts
├─ examples/                       # 手工验收用的示例项目（可选）
├─ eslint.config.ts
├─ vitest.config.ts
├─ vitest.e2e.config.ts            # 真实账号 E2E（FLASH_TUNNEL_E2E=1 才加载）
├─ tsconfig.json
├─ pnpm-workspace.yaml
├─ package.json
├─ .gitignore
├─ .editorconfig
├─ LICENSE
└─ README.md
```

## 根 `package.json`

```json
{
  "name": "flash-tunnel-monorepo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.12.1",
  "engines": { "node": ">=22.14.0" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/flash-tunnel/flash-tunnel.git"
  },
  "scripts": {
    "stub": "pnpm -r run stub",
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "tu": "vitest -u",
    "lint": "eslint --cache",
    "lint:fix": "eslint --cache --fix",
    "ft": "node ./packages/flash-tunnel/bin/flash-tunnel.mjs",
    "release": "bumpp -r",
    "prepare": "simple-git-hooks"
  },
  "devDependencies": {
    "@antfu/eslint-config": "^9.5.1",
    "@types/node": "^26.6.4",
    "@vitest/coverage-v8": "^5.0.3",
    "bumpp": "^12.3.0",
    "defu": "^6.1.7",
    "eslint": "^10.12.0",
    "nano-staged": "^1.0.2",
    "simple-git-hooks": "^2.14.0",
    "typescript": "^6.0.3",
    "unbuild": "^3.6.1",
    "vitest": "^5.0.3"
  },
  "simple-git-hooks": {
    "pre-commit": "pnpm nano-staged"
  },
  "nano-staged": {
    "*.{ts,tsx,js,mjs,cjs,json,jsonc,md,yml,yaml}": "eslint --cache --fix"
  }
}
```

> **版本从 `0.0.0` 开始**：根包 `private: true` 不发布；七个子包统一 `0.0.0`。其中 `flash-tunnel@0.0.0` 已由本地首次发布占位，其余六个 `@flash-tunnel/*` 用 `bootstrap` 标签补发；正式版本 `0.1.0` 在 release verify 通过且 Trusted Publisher 配置完成后发布（见「发布流程」）。
>
> `packageManager` 用 `pnpm@12.12.1`：该版本的 `pnpm publish` 已支持 OIDC（含 `NPM_ID_TOKEN` 的 `aud` 校验），是可信发布链路的最小版本。
>
> `repository.url` 必须与 GitHub 仓库**完全一致**：npm 的 Trusted Publisher 会校验这个字段，不一致会在发布时报 `ENEEDAUTH`。仓库是 `flash-tunnel/flash-tunnel`（本地 remote 为 `git@github.com:flash-tunnel/flash-tunnel.git`），npm 元数据统一写 `git+https://github.com/flash-tunnel/flash-tunnel.git`。
>
> 版本号以脚手架创建时 `pnpm add` 的解析结果为准；上表对齐参考仓库当前主版本（ESLint 10、antfu config 9、Vitest 5、unbuild 3、bumpp 12）。
>
> `engines.node >= 22.14` 的原因：Node 20 已 EOL；`styleText` 在 22.13 稳定（20.12+ 可用，20.18+ 起尊重 `NO_COLOR`/`FORCE_COLOR`）；同时与 npm 可信发布要求的 Node ≥22.14 对齐。verify 矩阵用 22/24 覆盖下限与当前 LTS。

## `pnpm-workspace.yaml`

```yaml
shellEmulator: true

packages:
  - packages/*

allowBuilds:
  esbuild: true
  simple-git-hooks: true
```

可选加固（与 `ext-kit`/`initx` 一致）：

```yaml
trustPolicy: no-downgrade
minimumReleaseAge: 1440          # 新版本发布满 1 天再采纳
minimumReleaseAgeExclude:
  - '@flash-tunnel/*'
```

`allowBuilds` 是 pnpm 12 的写法（`frp-bridge` 的 pnpm 10 用 `onlyBuiltDependencies`），本项目统一用 pnpm 12。

## `eslint.config.ts`

```ts
import { antfu } from '@antfu/eslint-config'

export default antfu({
  type: 'lib',

  rules: {
    'style/comma-dangle': ['warn', 'never'],
  },

  ignores: [
    '**/dist/**',
    '**/coverage/**',
    'ai-docs/**',
  ],
})
```

- `type: 'lib'` 与 `frp-bridge` 一致，适合库/CLI（不放宽浏览器相关规则）。
- 关闭尾逗号（`ext-kit` / `initx` / `frp-bridge` 的共同约定）。
- 忽略 `ai-docs/**`：设计文档包含大量表格与手写对齐，避免 `--fix` 反复改写。

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["packages/**/*.ts", "scripts/**/*.ts", "*.ts"],
  "exclude": ["**/dist/**", "**/node_modules/**"]
}
```

各包 `tsconfig.json`：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`noUncheckedIndexedAccess` 是额外硬化项：账本、事件、错误映射里大量数组/字典访问，能提前暴露空值问题。

## `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts', 'packages/cli/**', 'packages/flash-tunnel/**'],
      thresholds: { lines: 75, functions: 75, branches: 65 },
    },
  },
})
```

- 单元测试不联网：`undici` 的 `MockAgent` 在 `test/setup.ts` 里 `disableNetConnect()`。
- 集成测试标记 `test.concurrent` 谨慎使用（涉及端口与临时目录）。

## unbuild 共享配置

`scripts/build.common.ts`：

```ts
import type { BuildConfig } from 'unbuild'
import { defu } from 'defu'

const common: BuildConfig = {
  declaration: true,
  clean: true,
  rollup: {
    esbuild: { target: 'node20' },
    inlineDependencies: false,
    dts: { respectExternal: true },
  },
  failOnWarn: false,
}

export function mergeDefaultBuildConfig(config: BuildConfig): BuildConfig {
  return defu(config, common)
}
```

各包 `build.config.ts`：

```ts
import { defineBuildConfig } from 'unbuild'
import { mergeDefaultBuildConfig } from '../../scripts/build.common'

export default defineBuildConfig(mergeDefaultBuildConfig({
  entries: ['src/index'],
}))
```

与 `ext-kit` 的差异：**不** `inlineDependencies`，也不 minify。CLI 通过 `dependencies` 正常发布工作区包（`@flash-tunnel/core` 等），npx 安装时会一并拉取，避免把 core/adapter 打进单文件后难以定位问题。

## 包清单

| 包目录 | name | 关键依赖 | 发布 |
| --- | --- | --- | --- |
| `flash-tunnel` | `flash-tunnel` | `@flash-tunnel/cli`、`@flash-tunnel/config` | 是（bin） |
| `cli` | `@flash-tunnel/cli` | `@flash-tunnel/core`、`@flash-tunnel/config`、`@flash-tunnel/adapter-cloudflare`、`cac`、`yocto-spinner`、`@inquirer/prompts`、`open`、`clipboardy`（可选动态导入）、`qrcode-terminal`（可选） | 是 |
| `config` | `@flash-tunnel/config` | 无（standalone） | 是 |
| `core` | `@flash-tunnel/core` | `@flash-tunnel/types`、`@flash-tunnel/utils`、`@flash-tunnel/config`、`unconfig`、`jiti`、`defu`、`pathe`、`tinyglobby` | 是 |
| `types` | `@flash-tunnel/types` | 无 | 是 |
| `utils` | `@flash-tunnel/utils` | `pathe` | 是 |
| `adapter-cloudflare` | `@flash-tunnel/adapter-cloudflare` | `@flash-tunnel/types`、`@flash-tunnel/utils` | 是 |

> 不引入 `picocolors` / `chalk` / `ora`：颜色统一用 `node:util` 的 `styleText`，spinner 用 `yocto-spinner`（需 `handleSignals: false`），交互用 `@inquirer/prompts`。原因见 07 的「终端 UI 实现」。

### `flash-tunnel`（用户门面）

```json
{
  "name": "flash-tunnel",
  "version": "0.0.0",
  "type": "module",
  "bin": { "flash-tunnel": "bin/flash-tunnel.mjs" },
  "main": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "exports": {
    ".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" },
    "./config": { "types": "./dist/config.d.mts", "import": "./dist/config.mjs" }
  },
  "files": ["bin", "dist"],
  "engines": { "node": ">=22.14.0" },
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/flash-tunnel/flash-tunnel.git"
  },
  "dependencies": {
    "@flash-tunnel/cli": "workspace:*",
    "@flash-tunnel/config": "workspace:*"
  },
  "scripts": {
    "stub": "unbuild --stub",
    "build": "unbuild",
    "typecheck": "tsc --noEmit"
  }
}
```

```ts
// packages/flash-tunnel/src/index.ts
export { defineConfig } from '@flash-tunnel/config'
export type { FlashTunnelConfig, DomainConfig, ServerConfig, TunnelConfig } from '@flash-tunnel/config'
```

```ts
// packages/flash-tunnel/src/config.ts —— 子路径兼容入口
export * from '@flash-tunnel/config'
```

`build.config.ts` 需要两个 entry：

```ts
export default defineBuildConfig(mergeDefaultBuildConfig({
  entries: ['src/index', 'src/config'],
}))
```

### `@flash-tunnel/cli`

```json
{
  "name": "@flash-tunnel/cli",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "exports": {
    ".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" }
  },
  "files": ["dist"],
  "engines": { "node": ">=22.14.0" },
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/flash-tunnel/flash-tunnel.git"
  },
  "dependencies": {
    "@flash-tunnel/adapter-cloudflare": "workspace:*",
    "@flash-tunnel/config": "workspace:*",
    "@flash-tunnel/core": "workspace:*",
    "cac": "^7.0.0",
    "yocto-spinner": "^1.2.2",
    "@inquirer/prompts": "^8.7.4"
  },
  "scripts": {
    "stub": "unbuild --stub",
    "build": "unbuild",
    "typecheck": "tsc --noEmit"
  }
}
```

```ts
// packages/cli/src/index.ts
export async function runCli(argv: string[] = process.argv): Promise<void> {
  // 注册命令、处理信号、调用 runFlashTunnel
}
```

`bin/flash-tunnel.mjs`（零逻辑，只做入口）：

```js
#!/usr/bin/env node
'use strict'

import { runCli } from '@flash-tunnel/cli'

runCli()
```

Git 中必须保留可执行位：`git update-index --chmod=+x packages/flash-tunnel/bin/flash-tunnel.mjs`（npm 安装时会根据 bin 字段生成 shim，但仓库内直接执行需要）。文件使用 LF、无 BOM。

### `@flash-tunnel/config`

```ts
// packages/config/src/index.ts
import type { FlashTunnelConfig } from './types'

export function defineConfig<T extends FlashTunnelConfig>(config: T): T {
  return config
}

export type * from './types'
```

七个可发布包（`flash-tunnel`、`@flash-tunnel/cli`、`config`、`core`、`types`、`utils`、`adapter-cloudflare`）在首次发布前都保持 `0.0.0`，并各自带上与根一致的 `repository` 字段（npm 可信发布校验需要）。

## CLI 的 UI 代码组织

```text
packages/cli/src/
├─ index.ts            # 入口：runCli、信号注册、命令分发
├─ builtins.ts         # 内置适配器注入
├─ commands/           # start / clean / doctor / init / providers
└─ ui/
   ├─ output.ts        # human/json 双通道，决定 stream 与是否 TTY
   ├─ theme.ts         # styleText 主题（唯一允许出现颜色的地方）
   ├─ symbols.ts       # Unicode / ASCII 符号降级
   ├─ spinner.ts       # yocto-spinner 封装（handleSignals: false）
   ├─ step.ts          # 步骤编排：开始/成功/失败/耗时/phase
   └─ prompts.ts       # @inquirer/prompts 包装 + ExitPromptError → 中止
```

约束：

- `core` 不发 ANSI、不依赖任何 UI 库；只发事件与错误码。CLI 负责把事件映射为步骤行。
- 颜色只允许出现在 `theme.ts`；其它文件不得直接写 `\x1b[`（spinner 帧的颜色由 `yocto-spinner` 内部处理，不在此列）。
- `spinner.stop()` 必须覆盖 `finally` 与信号路径，保证光标恢复；`SIGINT` 处理先停 spinner 再清理。
- `prompts` 仅在交互模式调用；取消（`ExitPromptError`）统一转换为 `UserAbortError`，由入口按退出码 130 处理。
- 非 TTY / `--json` / `CI` 时，`output.ts` 不创建 spinner、不加载 prompts，避免在管道里输出控制字符。
- UI 单测以「关闭颜色 + 固定文本」断言为主，避免快照里出现终端转义序列。

## Git hooks

- `simple-git-hooks` 在 `prepare` 时安装；pnpm 需允许其构建脚本（`allowBuilds`）。
- `nano-staged` 只对暂存文件跑 ESLint（不跑全量、不跑测试），保证提交速度。
- 不在 pre-commit 跑 typecheck/test：CLI 项目全量类型检查耗时明显，交给 CI。
- 提交信息建议 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`），便于 `bumpp` 生成 CHANGELOG（如后续启用）。

## GitHub Actions（仅 tag 触发）

只有一个 workflow：`.github/workflows/release.yaml`，触发条件仅 `push.tags: ['v*']`；**不监听 push/PR**，也不存在独立的 `ci.yaml`。

workflow 内分两个 job：

1. `verify`：矩阵 Linux/Windows × Node 22/24，跑 `install → build → lint → typecheck → test`。
2. `publish`：`needs: verify`，只有 verify 全绿才执行，用 OIDC 发布。

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  verify:
    name: verify · ${{ matrix.os }} · Node ${{ matrix.node }}
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  publish:
    name: publish
    needs: verify
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      id-token: write   # npm Trusted Publishing 的 OIDC 交换
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24          # npm 要求 >= 22.14
          registry-url: 'https://registry.npmjs.org'
          package-manager-cache: false   # 发布构建不复用缓存
      - name: Ensure npm CLI >= 11.5.1
        run: npm i -g npm@latest
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm -r publish --access public --no-git-checks
```

说明：

- `pnpm/action-setup` 不写 `version`：从 `package.json#packageManager` 读取（参考 `ext-kit` 的注释）。
- Windows 必须进 verify 矩阵：进程树停止、路径、`styleText` 的 TTY 行为都依赖平台。
- **先 build 再 typecheck**：干净 checkout 下 workspace 包的类型入口指向 `dist`，未构建时 `tsc` 会找不到；根 `tsconfig` 的 `paths` 只是本地兜底。
- 因为只有 tag 触发，日常提交不会产生 Actions 运行；合并/发布前由本地 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 自查。
- 如果以后要拆出可复用的 check workflow，只能用 `workflow_call` 并由 `release.yaml` 调用，触发入口仍然是 tag。

约束（来自 npm 可信发布文档，容易踩）：

- Trusted Publisher 里配置的 **Workflow filename 必须精确等于 `release.yaml`**（只写文件名，含扩展名）。
- 发布工作流只能用 **GitHub 托管 runner**；self-hosted 不支持。
- 不要把 publish 放进 `workflow_call` 被子工作流调用：校验看的是调用方 workflow 名。
- 每个包的 `repository.url` 必须与 GitHub 仓库完全一致。
- `contents: read` 足够；如果以后加 `changelogithub` 生成 Release，再改成 `contents: write`。
- npm 会自动生成 provenance，不需要 `--provenance`（pnpm 在 OIDC 下同理）。

发布前检查（本地）：

```bash
pnpm build
node packages/flash-tunnel/bin/flash-tunnel.mjs --version
npm pack --dry-run   # 在 packages/flash-tunnel 下确认 bin/files 内容
```

## 发布流程

版本策略：**所有可发布包从 `0.0.0` 起步；`0.1.0` 是第一个正式版本**。首次发布必须手动完成一次占位发布，之后才能配置 Trusted Publisher（npm 只允许对已存在的包配置可信发布）。

### 阶段 0 · 0.0.0 占位发布（本地，一次性）

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# 确认包名与文件清单
(cd packages/flash-tunnel && npm pack --dry-run)
(cd packages/core && npm pack --dry-run)

# 首次发布：用 bootstrap 标签，避免 0.0.0 成为 latest
# 注意：flash-tunnel@0.0.0 已经存在（用户已手动发布），不要再重复发布
pnpm --filter "@flash-tunnel/*" -r publish --access public --tag bootstrap --no-git-checks
```

- 需要 npm 账号 2FA；这一步用本地登录态，不涉及 CI Token。
- **`flash-tunnel@0.0.0` 已存在**：它不能再发一次 0.0.0，否则 `pnpm publish` 会报版本已存在。当前只需补齐 `@flash-tunnel/*` 六个包；`flash-tunnel` 等 0.1.0 再发。
- `flash-tunnel@0.0.0` 保留现状：`latest` 继续指向它，不做 dist-tag 变更、不加 deprecate。0.1.0 发布时 `latest` 自然被覆盖。
- `--tag bootstrap` 让新发布的六个 `@flash-tunnel/*` 包只挂 `bootstrap`，不占 `latest`；`0.1.0` 发布后自动成为 `latest`。
- `0.0.0-stage` **不是 dist-tag，而是一个已发布的预发布版本**（版本号本身是 `0.0.0-stage`）；它不在任何 dist-tag 上。已确认可以删除，发布 0.1.0 前执行：

  ```bash
  npm unpublish flash-tunnel@0.0.0-stage
  ```

  必须在发布后 72 小时内操作；超过窗口只能联系 npm 支持。删除后 `npm view flash-tunnel versions` 只剩 `0.0.0`。
- 发布后到 npm 页面确认七个包都存在、`repository` 链接正确。

### 阶段 1 · tag 前的本地自查（建议）

- 因为 workflow 只在 tag 触发，push/PR 不会跑 Actions；发 tag 前在本地跑 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。
- 本地 Node 24 冒烟不是发布门槛，但建议跑一次。
- 如果 tag 后的 `verify` 失败，`publish` 会被跳过；修复后需要换一个新版本号重新打 tag（不要复用旧 tag）。

### 阶段 2 · 配置 Trusted Publisher（临近发布再做）

对七个包分别操作（npm → 包 → Settings → Trusted Publisher → GitHub Actions）：

| 字段 | 值 |
| --- | --- |
| Organization or user | `flash-tunnel`（GitHub 组织） |
| Repository | `flash-tunnel` |
| Workflow filename | `release.yaml` |
| Environment name | 留空 |
| Allowed actions | 勾选 `npm publish`（不需要 dist-tag） |

注意：**新建的可信发布配置必须在 2 天内完成第一次成功发布**，否则配置过期，只能删除重建。所以不要在 0.0.0 之后立刻配置然后长期不发布；等本地自查通过、准备发 0.1.0 时再配置，并在当天完成 tag 发布。

### 阶段 3 · 发布 0.1.0

```bash
pnpm release          # bumpp -r：全部包 0.0.0 → 0.1.0，提交并打 v0.1.0 tag
git push --follow-tags
```

tag 触发 `release.yaml`：先跑 `verify`（Linux/Windows × Node 22/24 的 build/lint/typecheck/test），全部通过后 `publish` 才执行 `pnpm -r publish`，通过 OIDC 完成发布并生成 provenance。

发布后检查：

- npm 上七个包都是 `0.1.0`，`latest` 指向 `0.1.0`。
- 六个 `@flash-tunnel/*` 的 `0.0.0` 只保留 `bootstrap` 标签；`flash-tunnel@0.0.0` 的 `latest` 已被 0.1.0 覆盖。
- 安装冒烟：`npx flash-tunnel@0.1.0 --version`。
- 首次 OIDC 发布成功后，把七个包的 Settings → Publishing access 改为 “Require two-factor authentication and disallow tokens”，此后只允许可信发布。
- 后续版本重复阶段 3；`bumpp -r` 保持七个包同版本。

### 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ENEEDAUTH` / 401 | 仓库、workflow 名或 `repository.url` 不匹配 | 逐字核对 Trusted Publisher 配置与 `package.json` |
| 可信配置过期 | 2 天内没有成功发布 | 删除配置，重新创建后立即发布 |
| `pnpm publish` 仍走 Token | pnpm 版本过旧 / `id-token` 权限缺失 | 确认 `pnpm@12.12.1`、`permissions.id-token: write` |
| provenance 缺失 | 仓库私有或非 OIDC 发布 | 公开仓库 + 可信发布才会自动生成 |
| `npm install flash-tunnel` 装到 0.0.0 占位包 | 尚未发布 0.1.0，`latest` 仍指向 0.0.0 | 属预期；0.1.0 发布后覆盖，或临时用 `flash-tunnel@bootstrap` 之外的明确版本 |

## 编码约定

| 项 | 约定 |
| --- | --- |
| 文件/目录 | kebab-case（`state-store.ts`、`adapter-cloudflare`） |
| 变量/函数 | camelCase；适配器实例 `cloudflareDns` / `cloudflareTunnel` |
| 类型 | PascalCase；配置类型统一 `FlashTunnel*` 前缀避免与用户配置混淆 |
| 错误 | 只抛 `FlashTunnelError` / `AdapterError`，禁止 `throw 'string'` |
| 日志 | core 不 `console.log`，统一注入 logger；CLI 负责最终渲染 |
| 颜色/动画 | 只在 `cli/src/ui/theme.ts`、`spinner.ts`；其它层不出现 ANSI |
| 副作用 | 适配器方法不做模块级副作用；进程启动集中在 `core/server` 与 `tunnel.start` |
| 类型导入 | `import type`（`verbatimModuleSyntax` 强制） |
| 注释 | 解释「为什么」，不写「做了什么」；公开 API 用 JSDoc 写清幂等与错误语义 |
| 文档 | 设计文档中文；代码标识符英文 |

## 与参考仓库的差异说明

| 参考 | 相同 | 不同 |
| --- | --- | --- |
| `ext-kit` | antfu 配置、无尾逗号、hooks、unbuild、vitest | 本项目保持外部依赖（不 inline），CLI 需 `bin` |
| `initx` | `unbuild --stub` 开发、`bin` 薄包装、工作区 `workspace:*` | 增加适配器包与 `./config` 导出 |
| `frp-bridge` | 包拆分（cli/core/types/shared）、`cac` | 用 unbuild 而非 rolldown；适配器独立成包 |
| `synra-monorepo` | unconfig、严格 tsconfig、`ai-docs` 文档习惯 | 不引入 vite-plus/catalogs，保持轻量 |
