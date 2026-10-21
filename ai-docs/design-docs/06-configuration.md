# 06 · 配置系统

## 共识：配置文件是可选的

1. **不写配置也能跑**：默认值来自三类来源——项目探测、环境变量、唯一候选推断（例如账号下只有一个 Zone）。
2. **配置只做覆盖**：凡是能从项目或供应商状态推导出来的，都不做成开关；避免出现「配置 A 与事实 B 冲突」的非法状态。
3. **配置不承载凭据与安全开关**：Token 只走环境变量；清理行为不能在仓库里的配置文件中被关掉。
4. **默认必须可解释**：`--dry-run` 会输出每个生效值的来源（`default` / `detected` / `env` / `config` / `inferred`），推导失败时给出可操作的错误，而不是猜。

## 文件发现

- 文件名固定 `flash-tunnel.ts`，**只接受 `.ts`**（不读 `.js`/`.mjs`/`.cts`/`package.json`）。
- 从 `cwd` 向上查找，遇到 git 仓库根或文件系统根停止；找到第一个即用。
- 配置里的相对路径（`server.cwd`、`server.dir`）以**配置文件所在目录**为基准，而不是执行目录；这样根配置可以稳定地指向 `apps/web`。
- `--config <path>` 跳过查找，直接加载（相对路径按 `cwd` 解析）。
- 没有配置文件时使用全默认值；加载成功后在 `--verbose` 输出 `config: /abs/path/flash-tunnel.ts`。
- 配置不热更新：改了配置需要重启。

## 用 unconfig 加载

```ts
import { loadConfig } from 'unconfig'

export async function loadFlashTunnelConfig(cwd: string) {
  const { config, sources } = await loadConfig<FlashTunnelConfig>({
    cwd,
    sources: [{
      files: 'flash-tunnel',
      extensions: ['ts'],
    }],
    merge: false,
  })
  return { raw: config, source: sources[0] }
}
```

- `merge: false`：多文件合并/向上继承由我们控制（只取第一个命中）。
- 加载失败分类：

| 失败 | 判定 | 提示 |
| --- | --- | --- |
| 语法错误 | jiti 抛 SyntaxError | 文件路径、行号、原始错误 |
| 无法解析 import | `Cannot find module` | 只应使用 `import type`、`flash-tunnel`、`flash-tunnel/config` 或 `@flash-tunnel/config`；npx 场景走 shim |
| 默认导出缺失 | `config == null` | 提示 `export default defineConfig({...})` |
| 默认导出非对象 | `typeof !== 'object'` | 同上 |
| 字段校验失败 | 类型/枚举/范围错误 | 列出具体路径（`server.timeout` 期望正整数） |

显式路径（`--config`）用同一个 jiti 实例直接 `import(fileUrl)`。

## 配置面

目标：**17 个字段，常用 5 个**。没有 `cleanup`、`ui`、`hooks` 分组，也没有 DNS 记录细节（类型/代理/TTL 由隧道能力派生）。

```ts
export interface FlashTunnelConfig {
  domain?: DomainConfig
  server?: ServerConfig
  tunnel?: TunnelConfig
  providers?: ProvidersConfig
  /** 到达时长后自动停止并清理，默认关闭 */
  autoStopAfter?: string | number
}

export interface DomainConfig {
  /** DNS 适配器，默认 'cloudflare' */
  provider?: string
  /** 主域名（Zone），如 example.com；默认取账号下唯一 Zone */
  zone?: string
  /** 子域模板或字面量，默认 '{project}-{rand}'；不含 zone */
  subdomain?: string
}

export interface ServerConfig {
  /** 显式启动命令；设置后不再自动探测脚本 */
  command?: string
  /** 子进程工作目录，默认配置文件所在目录 */
  cwd?: string
  /** 期望端口；默认从输出/框架推断 */
  port?: number
  /** 已运行服务地址；只写 url 表示复用，不启动 */
  url?: string
  /** 静态目录；只写 dir 表示内置静态托管 */
  dir?: string
  /** 就绪超时（毫秒），默认 60000 */
  timeout?: number
}

export interface TunnelConfig {
  /** 隧道适配器，默认 'cloudflare' */
  provider?: string
  /** 默认 'named'（无 Token 时 TTY 询问是否降级 quick） */
  mode?: 'named' | 'quick'
  /** 隧道资源名模板，默认 'flash-tunnel-{project}-{rand}' */
  name?: string
}

export interface ProvidersConfig {
  cloudflare?: {
    /** 默认：环境变量 → Token 可见的唯一账号 */
    accountId?: string
    /** 默认：按 domain.zone 查询 */
    zoneId?: string
    /** 默认：PATH 中查找 cloudflared */
    cloudflaredPath?: string
    /** 逃生阀：透传给 ingress 的 originRequest */
    originRequest?: {
      httpHostHeader?: string
      noTLSVerify?: boolean
    }
  }
  [providerId: string]: unknown
}
```

字段之间的推断关系（不引入 `server.type` 枚举）：

| 你写了什么 | 行为 |
| --- | --- |
| 什么都没写 | 自动探测项目并启动 |
| `command` | 用它启动；`url` 可选，作为期望地址 |
| 只有 `url` | 直接复用，不启动；不可达则报错 |
| 只有 `dir` | 内置静态服务器托管该目录 |
| `url` + `dir` / `command` + `dir` | 校验错误（互相矛盾） |

`autoStopAfter` 接受 `'30m'`、`'2h'`、`'90s'` 或毫秒数（≥ 1000）；到点后走正常清理流程并以退出码 0 结束。

## 默认行为（无配置时）

| 配置项 | 默认行为 | 推导来源 / 失败路径 |
| --- | --- | --- |
| `domain.zone` | `FLASH_TUNNEL_ZONE` → 账号唯一 Zone → TTY 交互选择 → 报错 | `GET /zones`；CI/非 TTY 直接报错并列出候选 |
| `domain.subdomain` | `{project}-{rand4}`；超长截断并附 4 位 hash | package name / 目录名 |
| `domain.provider` | `cloudflare` | 当前唯一内置 |
| `server.command` | `preview`（有产物）→ `dev` → `start` | scripts + 产物探测；preview 无产物自动降级 `dev` 并提示 |
| `server.cwd` | 配置文件所在目录；无配置时为执行目录 | |
| `server.port` | 输出解析 → 脚本参数 → 框架默认 | 静态模式取空闲端口 |
| `server.url` | 不设置；启动后探测 | |
| `server.dir` | 探测 `dist`→`build`→`out`→`public`（需含 `index.html`） | 仅在无脚本且无 command 时启用 |
| `server.timeout` | 60000 | |
| `tunnel.provider` | `cloudflare` | |
| `tunnel.mode` | `named` | 无 Token：TTY 询问是否 quick（默认否）；非 TTY 报错并提示 `--quick` |
| `tunnel.name` | `flash-tunnel-{project}-{rand4}` | |
| `providers.cloudflare.accountId` | `CLOUDFLARE_ACCOUNT_ID` → Token 可见唯一账号 | 多账号且无法确定 → 报错 |
| `providers.cloudflare.zoneId` | `CLOUDFLARE_ZONE_ID` → 按 zone 名查询 | 查询 403 → 提示直接配置 zoneId |
| `providers.cloudflare.cloudflaredPath` | PATH 查找 `cloudflared` | 找不到 → 提示安装命令 |
| `providers.cloudflare.originRequest` | 空；HTTPS 源站自动 `noTLSVerify: true` | |
| `autoStopAfter` | 关闭 | 仅显式配置才启用 |

两个由适配器派生的默认行为，值得单独记住：

- **DNS 记录细节不配置**：记录类型、`proxied`、`TTL` 全部由隧道能力决定（Cloudflare named 恒为 CNAME + 橙云 + 自动 TTL）。
- **同名记录自动回收**：若冲突记录带本工具标记（`comment` 以 `flash-tunnel:` 开头），直接回收重建；非本工具记录才报错，需 `--overwrite`。这样固定子域在崩溃后重跑能自愈。

## 模板变量

适用于 `domain.subdomain`、`tunnel.name`：

| 变量 | 值 | 示例 |
| --- | --- | --- |
| `{project}` | package name 或目录名，slug 化 | `my-app` |
| `{branch}` | 当前 git 分支，slug 化；无 git 为 `nogit` | `feat-login` |
| `{rand}` / `{rand:N}` | 随机小写字母数字，默认 4 位，排除 `0/o/1/l` | `k3f9` |
| `{ts}` | base36 时间戳（秒） | `m3k9x` |
| `{session}` | 会话 id | `ft_m3k9x_7fa2` |

slug 规则：小写、非法字符替换为 `-`、合并连续 `-`、去首尾、截断到 24 字符。DNS 标签 ≤ 63、FQDN ≤ 253；超长自动截断并追加 4 位 hash 保证唯一。多级子域默认拒绝，需 CLI `--allow-multilevel`，并提示 Advanced Certificate 限制。

## 环境变量

| 变量 | 作用 | 对应配置 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（唯一凭据来源） | — |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 id | `providers.cloudflare.accountId` |
| `CLOUDFLARE_ZONE_ID` | Zone id | `providers.cloudflare.zoneId` |
| `FLASH_TUNNEL_ZONE` | 主域名 | `domain.zone` |
| `FLASH_TUNNEL_HOSTNAME` | 完整主机名（跳过 zone/模板） | — |
| `FLASH_TUNNEL_MODE` | `named` / `quick` | `tunnel.mode` |
| `FLASH_TUNNEL_TUNNEL_PROVIDER` | 隧道适配器 | `tunnel.provider` |
| `FLASH_TUNNEL_DNS_PROVIDER` | DNS 适配器 | `domain.provider` |
| `FLASH_TUNNEL_PORT` | 期望端口 | `server.port` |
| `FLASH_TUNNEL_COMMAND` | 启动命令 | `server.command` |
| `FLASH_TUNNEL_CLOUDFLARED` | cloudflared 路径 | `providers.cloudflare.cloudflaredPath` |
| `FLASH_TUNNEL_AUTO_STOP` | 自动停止时长 | `autoStopAfter` |
| `FLASH_TUNNEL_NO_OPEN` | 不打开浏览器 | — |
| `NO_COLOR` / `FORCE_COLOR` / `NODE_DISABLE_COLORS` | 终端颜色（`styleText` 原生尊重） | — |
| `CI` | 关闭交互与动画 | — |

`FLASH_TUNNEL_HOSTNAME` 是完整 FQDN（含 zone），用于 CI 里固定地址；与 `domain.zone`/`subdomain` 同时存在时以它为准。

## 优先级

```text
CLI 参数  >  环境变量  >  flash-tunnel.ts  >  自动探测/默认值
```

同一字段只取第一个有值的来源。凭据不存在优先级问题：只读环境变量。

## 三个配置入口

```ts
// 1) 安装 flash-tunnel 后的推荐写法
import { defineConfig } from 'flash-tunnel'

// 2) 显式子路径（保留兼容）
import { defineConfig } from 'flash-tunnel/config'

// 3) 只用配置类型包（不装 CLI）
import { defineConfig } from '@flash-tunnel/config'
```

`flash-tunnel` 根导出与 `flash-tunnel/config` 都是对 `@flash-tunnel/config` 的再导出；`@flash-tunnel/config` 只含 `defineConfig`（identity）与配置类型，不依赖 CLI。

`npx flash-tunnel` 时包在临时目录，项目 `node_modules` 里没有 `flash-tunnel`，jiti 解析上面的 import 会失败。加载时用 unconfig 的 `transform` 把 `flash-tunnel` 相关 import 重写为运行中 CLI 自带 config 包的绝对 URL：

```ts
const shim = pathToFileURL(require.resolve('@flash-tunnel/config')).href

transform(code) {
  return code
    .replace(/(from\s*)(['"])flash-tunnel\/config\2/g, `$1'${shim}'`)
    .replace(/(from\s*)(['"])flash-tunnel\2/g, `$1'${shim}'`)
}
```

- 只重写裸包名 `flash-tunnel` 与 `flash-tunnel/config`；`@flash-tunnel/config` 若已在项目依赖中则正常解析，不在时也可被同一规则指到 CLI 自带副本（实现时可一并处理）。
- shim 只导出 `defineConfig` 与类型，避免用户以为配置里有运行时能力。
- `import type { FlashTunnelConfig } from 'flash-tunnel'` 会被擦除，不受影响。
- 用户把 `flash-tunnel` 装成 devDependency 时正常解析，行为一致。

不依赖包安装的写法同样支持：

```ts
import type { FlashTunnelConfig } from 'flash-tunnel'

export default {
  domain: { zone: 'example.com' },
} satisfies FlashTunnelConfig
```

## 示例

### 最小

```ts
import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  domain: { zone: 'example.com' },
})
```

### Vite 项目：固定端口、开发模式、自动到期

```ts
export default defineConfig({
  domain: { zone: 'example.com', subdomain: '{project}-{branch}' },
  server: { command: 'pnpm dev', port: 5173, timeout: 90_000 },
  autoStopAfter: '4h',
})
```

### monorepo：根配置指向子包

```ts
export default defineConfig({
  domain: { zone: 'example.com', subdomain: 'web-{rand}' },
  server: { cwd: 'apps/web', command: 'pnpm dev' },
})
```

### 静态产物

```ts
export default defineConfig({
  domain: { zone: 'example.com' },
  server: { dir: 'dist' },
})
```

### 无 Token 的快速模式

```ts
export default defineConfig({
  tunnel: { mode: 'quick' },
})
```

### 未来：Cloudflare 域名 + frp 隧道

```ts
export default defineConfig({
  domain: { provider: 'cloudflare', zone: 'example.com' },
  tunnel: { provider: 'npm:flash-tunnel-adapter-frp' },
  providers: {
    // 只放非敏感定位信息；FRP_TOKEN 由环境变量提供
    frp: { serverAddr: 'frp.example.com' },
  },
})
```

## 哪些东西不放进配置文件

| 项 | 原因 | 放在哪 |
| --- | --- | --- |
| API Token / 任何凭据 | 配置文件会进 git | 只读环境变量 |
| 是否清理、保留资源 | 写进仓库等于替同事关掉产品承诺 | `--keep`（调试，显著警告） |
| 浏览器/剪贴板/二维码 | 取决于 TTY/CI | 默认按 TTY，`FLASH_TUNNEL_NO_OPEN` / `--no-open` |
| 颜色/动画/日志级别 | 与环境强相关 | `NO_COLOR`/`FORCE_COLOR`/`CI`、`--no-color`、`--no-spinner`、`--verbose` |
| DNS 记录类型/代理/TTL | 由适配器能力派生 | 不开放 |
| 覆盖非本工具记录 | 高危且低频 | `--overwrite` |
| 多级子域 | 低频且需证书 | `--allow-multilevel` |
| 端口占用时复用 | 一次性决策 | `--reuse` |
| 就绪正则 | 用 `port`/`url` 已可兜底 | 不开放 |
| hooks / 通知编排 | 与 `--on-ready` 重复 | `--on-ready` 或编程 API |
| 重试次数/单步超时 | 实现细节 | 内部常量 |

## 校验与可解释性

- 未知字段：**警告**（向前兼容），`doctor` 中汇总。
- 类型错误：报错并给出字段路径。
- 语义冲突：如只配 `url` 又配 `dir`、`domain.zone` 缺失却用 named 模式 → 报错并给出两种修复。
- `--dry-run` 输出生效配置及来源，例如：

```text
生效配置
  domain.zone       example.com        (inferred: 账号下唯一 Zone)
  domain.subdomain  my-app-k3f9        (default: {project}-{rand})
  server.command    pnpm dev           (detected: scripts.dev；preview 产物缺失)
  server.port       5173               (detected: 输出 "Local: http://localhost:5173")
  tunnel.mode       named              (default)
  autoStopAfter     off                (default)
```

- 所有默认值必须能从这行来源解释；解释不了的值不允许存在。
