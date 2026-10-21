# 03 · 适配器契约与组合规则

## 为什么拆成 DNS 与隧道两个契约

把「暴露一个本地服务」拆开看，实际发生的是两件独立的事：

1. **拿到一个公网入口**：在某个隧道/中继服务上创建资源、启动连接进程、拿到流量落点（云厂商隧道、frp、ngrok……）。
2. **让域名指向这个入口**：在 DNS 服务商上增删记录（Cloudflare、DNSPod、阿里云……）。

两者经常来自同一家（Cloudflare 的 CNAME → `<tunnel-id>.cfargotunnel.com`），但并不必然：自建 frp 可以用任意 DNS 建 CNAME；某些隧道直接分配域名（`*.trycloudflare.com`、ngrok 免费域名），根本不需要 DNS 步骤。

因此契约拆成 `DnsAdapter` + `TunnelAdapter`，由编排器按隧道声明的 `requiresDns` 决定是否插入 DNS 步骤。**隧道声明「需要什么 DNS」，DNS 适配器声明「能做什么」，编排器校验两者是否匹配。**

## 公共约定

```ts
// @flash-tunnel/types

export const ADAPTER_API_VERSION = 1

export interface AdapterContext {
  sessionId: string
  /** 项目根目录，用于解析相对路径与读取本地文件 */
  cwd: string
  logger: AdapterLogger
  /** 用户中断信号；适配器应在长操作中检查 */
  signal: AbortSignal
  /** 注入时钟，便于测试 */
  now: () => number
}

export interface AdapterLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

export interface AdapterErrorOptions {
  code: string
  retriable?: boolean
  /** 面向用户的修复建议 */
  hint?: string
  cause?: unknown
  details?: Record<string, unknown>
}

export class AdapterError extends Error {
  readonly code: string
  readonly retriable: boolean
  readonly hint?: string
  readonly details?: Record<string, unknown>
}
```

约束：

- 所有适配器方法**必须幂等**：重复 `ensure` 同一记录不应产生第二条；重复 `remove`/`deprovision` 遇到 404 视为成功。
- 适配器**不持久化凭据**，也不把 token 写入日志；日志里出现的 token/secret 由 core 的脱敏层兜底，但适配器仍应主动避免。
- 适配器只做控制面（API + 进程），不启动本地业务服务。
- 所有可等待操作接受 `signal`，被中断时抛 `AdapterError({ code: 'ABORTED' })`。

## DNS 适配器

```ts
export type DnsRecordType = 'CNAME' | 'A' | 'AAAA' | 'TXT'

export interface DnsCapabilities {
  recordTypes: DnsRecordType[]
  /** 是否支持代理（Cloudflare 橙云） */
  proxied: boolean
  /** 是否支持自定义 TTL，false 表示只能自动 */
  ttl: boolean
  /** 是否支持记录备注，用于归属标记与清理扫描 */
  comment: boolean
  /** 是否支持按名称精确查询 */
  lookupByName: boolean
}

export interface DnsRecordSpec {
  /** 例如 example.com */
  zone: string
  /** 完整记录名，例如 preview-abc.example.com */
  name: string
  type: DnsRecordType
  content: string
  proxied?: boolean
  ttl?: number
  /** 归属标记，形如 flash-tunnel:ft_m3k9x_7fa2 */
  comment?: string
}

export interface DnsRecordRef {
  provider: string
  zoneId: string
  recordId: string
  name: string
  type: DnsRecordType
  content: string
  proxied: boolean
}

export interface DnsAdapter {
  readonly kind: 'dns'
  readonly id: string
  readonly apiVersion: typeof ADAPTER_API_VERSION
  readonly capabilities: DnsCapabilities

  /**
   * 在创建任何资源前验证凭据、Zone 归属与目标记录可用性。
   * 失败必须抛 AdapterError，不应产生副作用。
   */
  preflight(ctx: AdapterContext, target: {
    zone: string
    name: string
    type: DnsRecordType
    /** 已存在同名记录时是否允许覆盖（默认 false） */
    overwrite?: boolean
  }): Promise<void>

  /** 创建记录；若已存在同名同内容记录，直接返回其 ref */
  ensure(ctx: AdapterContext, spec: DnsRecordSpec): Promise<DnsRecordRef>

  /** 删除记录；记录不存在视为成功 */
  remove(ctx: AdapterContext, ref: DnsRecordRef): Promise<void>

  /** 查询记录，用于冲突检测与孤儿清理 */
  find(ctx: AdapterContext, query: {
    zone: string
    name?: string
    comment?: string
  }): Promise<DnsRecordRef[]>
}
```

`preflight` 的存在是为了满足「失败不留半套资源」：Token 无效、Zone 不在账号下、同名记录冲突这类问题必须在创建隧道之前暴露。

## 隧道适配器

```ts
export type TunnelMode = 'named' | 'quick' | 'assigned'

export interface TunnelCapabilities {
  /** 支持的工作模式；MVP 的 Cloudflare 支持 named（quick 为可选降级） */
  modes: TunnelMode[]
  /** 期望域名由谁决定：custom=用户指定；assigned=供应商分配；both=两者皆可 */
  publicHostname: 'custom' | 'assigned' | 'both'
  /** 是否需要外部 DNS 记录才能访问 */
  requiresDns: boolean
  /** 需要 DNS 时的具体要求；requiresDns=false 时可省略 */
  dns?: {
    type: DnsRecordType
    /** 记录内容如何得到（由 handle.dns.target 提供） */
    targetFrom: 'handle'
    proxied: boolean
    /** 只允许这些 DNS 适配器 id（例如 cfargotunnel 只对 Cloudflare 代理生效） */
    providerAffinity?: string[]
  }
  /** 是否允许同一供应商账号下并发多个实例 */
  concurrent: boolean
}

export interface TunnelProvisionSpec {
  /** 隧道资源名，如 flash-tunnel-my-app-k3f9 */
  name: string
  /** 期望公网主机名（publicHostname 含 custom 时必填） */
  hostname?: string
  /** 本地服务地址，如 http://127.0.0.1:5173 */
  localUrl: string
  /** 归属标记 */
  comment?: string
}

export interface TunnelSecrets {
  /** 运行连接进程所需 token；仅存内存，不落盘、不打日志 */
  token?: string
  /** 本地管理模式下的凭据文件路径 */
  credentialsFile?: string
}

export interface TunnelHandle {
  provider: string
  tunnelId: string
  name: string
  /** 供应商直接分配的访问地址（quick/assigned 模式） */
  publicUrl?: string
  /** 需要创建的 DNS 记录；requiresDns=false 时为 undefined */
  dns?: {
    type: DnsRecordType
    target: string
    proxied: boolean
  }
  secrets: TunnelSecrets
  /** 供应商侧清理需要的附加信息（区域、账号等） */
  meta?: Record<string, string>
}

export interface TunnelStatus {
  state: 'starting' | 'connected' | 'degraded' | 'stopped'
  connections: number
  /** 供应商报告的边缘位置等诊断信息 */
  detail?: string
}

export interface TunnelHooks {
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  /** 连接进程意外退出时回调；core 据此进入 tearing-down */
  onExit?: (info: { code: number | null, signal: string | null }) => void
}

export interface TunnelAdapter {
  readonly kind: 'tunnel'
  readonly id: string
  readonly apiVersion: typeof ADAPTER_API_VERSION
  readonly capabilities: TunnelCapabilities

  preflight(ctx: AdapterContext, opts: { hostname?: string, mode: TunnelMode }): Promise<void>

  /** 创建隧道资源与控制面配置（ingress），不启动连接进程 */
  provision(ctx: AdapterContext, spec: TunnelProvisionSpec): Promise<TunnelHandle>

  /** 启动连接进程（cloudflared / frpc / …） */
  start(ctx: AdapterContext, handle: TunnelHandle, hooks: TunnelHooks): Promise<void>

  /** 等待隧道真正可服务（连接数 > 0 / 供应商就绪位） */
  waitReady(ctx: AdapterContext, handle: TunnelHandle, timeoutMs: number): Promise<TunnelStatus>

  /** 停止连接进程；不删除控制面资源 */
  stop(ctx: AdapterContext, handle: TunnelHandle): Promise<void>

  /** 删除控制面资源；必须容忍资源已不存在 */
  deprovision(ctx: AdapterContext, handle: TunnelHandle): Promise<void>

  /** 可选：主动查询状态（用于运行期健康检查） */
  status?(ctx: AdapterContext, handle: TunnelHandle): Promise<TunnelStatus>
}
```

关键点：

- `provision` 与 `start` 分离，才能保证「DNS 建好之后再拉起进程」或反向顺序可控；也方便快速模式（无 DNS）复用同一流程。
- `handle.dns` 是「隧道告诉编排器该怎么配 DNS」的唯一通道，避免 core 里出现 `if (provider === 'cloudflare')`。
- `secrets` 与 `meta` 分开：前者不可落盘，后者可写状态文件用于恢复。

## 能力矩阵

| 适配器 | 模式 | 公网域名 | 需要 DNS | DNS 类型 / 代理 | 可清理 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `cloudflare`（tunnel, named） | named | custom | 是 | CNAME / 必须 proxied | 隧道 + 记录 | MVP 默认 |
| `cloudflare`（tunnel, quick） | quick | assigned | 否 | — | 仅进程 | 无需 Token，降级方案 |
| `cloudflare`（dns） | — | — | — | CNAME/A/AAAA/TXT，支持 proxied/TTL/comment | 记录 | 需 Zone 在账号下 |
| `frp`（未来） | named | custom 或 assigned | 视部署 | CNAME 或 A | 隧道 + 记录 | 自建 frps |
| `ngrok`（未来） | assigned | assigned | 否 | — | 进程/API | 免费版域名随机 |
| `dnspod`/`aliyun`（未来） | — | — | — | A/CNAME/TXT | 记录 | 与 CF 隧道不兼容 |

## 组合校验规则

`resolveAdapters(config)` 产出 `{ tunnel, dns? }`，并按以下顺序校验；错误在启动前抛出，警告写入日志：

| # | 条件 | 级别 | 处理 |
| --- | --- | --- | --- |
| C1 | `tunnel.capabilities.requiresDns && !dns` | error | 提示配置 `domain.provider` 或改用 `quick` 模式 |
| C2 | `tunnel.capabilities.dns.type` 不在 `dns.capabilities.recordTypes` | error | 列出租适配器支持的记录类型 |
| C3 | `tunnel.capabilities.dns.proxied && !dns.capabilities.proxied` | error | 说明该隧道必须经代理 |
| C4 | `dns.id` 不在 `tunnel.capabilities.dns.providerAffinity` 中 | error | 列出兼容的 DNS 适配器；编程 API 可显式跳过校验 |
| C5 | 用户配置了 `domain.*`，但 `tunnel.publicHostname === 'assigned'` | warn | 忽略 DNS 配置，使用供应商分配地址 |
| C6 | 用户配置了 `subdomain`，但 `publicHostname === 'assigned'` | warn | 忽略并说明 |
| C7 | `tunnel.capabilities.modes` 不含配置的 `mode` | error | 列出可选模式 |

`autoStopAfter` 是会话级能力，与适配器的 TTL 无关，不参与组合校验。

## 注册、发现与加载

### 内置适配器

`core` **不静态依赖**任何适配器包。内置适配器由 CLI 在启动时注入，core 只维护查找表：

```ts
// packages/cli/src/builtins.ts
import { cloudflareDns, cloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'

export const builtinAdapters = {
  tunnel: { cloudflare: () => cloudflareTunnel },
  dns: { cloudflare: () => cloudflareDns },
}
```

```ts
// packages/core/src/adapters/registry.ts
export function resolveBuiltin(kind: 'dns' | 'tunnel', id: string, builtins: BuiltinAdapters) {
  const factory = builtins[kind][id]
  if (!factory) return undefined
  return factory()
}
```

这样依赖方向保持 `cli → adapter-*`，`core` 只认契约；测试里也可以注入 fake 内置适配器。第三方/本地适配器仍走下面的动态加载路径。

### 第三方/本地适配器

配置里 `provider` 支持三种写法：

```ts
dns: { provider: 'cloudflare' }                     // 内置
dns: { provider: 'npm:@acme/flash-tunnel-dnspod' }  // npm 包
dns: { provider: './adapters/my-dns.ts' }           // 本地文件（TS 由 jiti 加载）
```

解析规则：

1. 以 `.` 或 `/` 开头 → 相对 `cwd` 解析为绝对路径，用 jiti 导入（复用 unconfig 的 ts loader，避免再引一套）。
2. 以 `npm:` 开头 → 去掉前缀后，从 `cwd` 的 `node_modules` 解析（`createRequire(cwd/package.json).resolve`）；解析失败再退回从 CLI 自身解析（兼容全局安装的适配器）。
3. 其它裸标识符 → 先按内置表查找，再按 npm 包解析。
4. 导入结果必须是 `{ kind, apiVersion, ... }` 对象，或 `{ dns?, tunnel? }` 聚合对象；用运行时守卫校验（不引 zod）。

```ts
export function isDnsAdapter(value: unknown): value is DnsAdapter {
  const v = value as DnsAdapter
  return !!v && v.kind === 'dns' && v.apiVersion === ADAPTER_API_VERSION
    && typeof v.ensure === 'function' && typeof v.remove === 'function'
    && Array.isArray(v.capabilities?.recordTypes)
}
```

`apiVersion` 不匹配时给出明确错误（而不是运行时崩溃）。第三方适配器应把 `@flash-tunnel/types` 放在 `peerDependencies`，避免重复的类型实例。

### 配置注入

适配器的**非敏感**定位信息来自 `config.providers[id]`；凭据只从环境变量读取，再由 core 合并进适配器选项：

```ts
// core 组装，不落盘、不进配置文件
const cloudflareOptions = {
  apiToken: process.env.CLOUDFLARE_API_TOKEN, // 唯一来源
  accountId: config.providers?.cloudflare?.accountId,
  zoneId: config.providers?.cloudflare?.zoneId,
  cloudflaredPath: config.providers?.cloudflare?.cloudflaredPath ?? 'cloudflared',
}
```

配置文件里**没有** `apiToken` 字段（类型层面就不存在）。适配器只读取自己命名空间下的选项，不直接读 `process.env`；env → options 的映射由 core 完成，测试可完全脱离环境变量。

## 编排器视角的调用顺序

```text
tunnel.preflight (hostname 合法、Token 权限、cloudflared 可用)
dns.preflight    (Zone 归属、记录冲突)          [requiresDns]
tunnel.provision (创建隧道 + ingress)
dns.ensure       (创建记录)                      [requiresDns]
tunnel.start     (启动 cloudflared)
tunnel.waitReady (连接就绪)
public verify    (HTTPS 探测，core 实现，非适配器职责)
...
tunnel.stop
dns.remove
tunnel.deprovision
```

失败位置对应的回滚范围见 08 文档；重试策略（`retriable`）在 core 统一实现，适配器不自行 sleep 重试。

## 适配器错误码约定

| code | 含义 | retriable |
| --- | --- | --- |
| `AUTH_INVALID` | Token 无效/过期/权限不足 | 否 |
| `ZONE_NOT_FOUND` / `ZONE_NOT_ACTIVE` | Zone 不存在或未激活 | 否 |
| `ACCOUNT_NOT_FOUND` | 账号 id 错误或不可见 | 否 |
| `RECORD_CONFLICT` | 同名记录已存在且内容不同 | 否 |
| `RECORD_CREATE_FAILED` / `RECORD_DELETE_FAILED` | DNS API 失败 | 视 HTTP 状态 |
| `TUNNEL_CREATE_FAILED` | 创建隧道失败 | 视状态 |
| `TUNNEL_NOT_CONNECTED` | 等待连接超时 | 是 |
| `TUNNEL_DELETE_BLOCKED` | 隧道仍有活跃连接 | 是（先清理连接） |
| `PROCESS_SPAWN_FAILED` | 二进制缺失/不可执行 | 否 |
| `PROCESS_EXITED` | 连接进程异常退出 | 否 |
| `RATE_LIMITED` | 供应商限流 | 是 |
| `ABORTED` | 用户中断 | 否 |

`AdapterError.retriable` 由适配器判断，core 只对 `retriable` 的错误做有限重试（默认 3 次，指数退避，仅用于清理路径与 `waitReady`）。

## 第三方适配器发布规范

- 包名建议 `flash-tunnel-adapter-<vendor>`（社区）或 `@scope/flash-tunnel-adapter-<vendor>`。
- 默认导出实现对象；同时导出 `defineDnsAdapter` / `defineTunnelAdapter` 的类型辅助。
- `peerDependencies`: `@flash-tunnel/types`（版本范围与 CLI 主版本对齐）。
- 提供 README，声明能力矩阵与实际行为（是否创建记录、是否可并发、清理语义）。
- 可选：使用 `@flash-tunnel/testing` 的一致性测试套件（见 10 文档，M4 交付）验证契约。
