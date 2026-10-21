# 02 · 总体架构

## 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ flash-tunnel (packages/flash-tunnel)                         │
│ 用户门面：bin · 重导出 defineConfig / 配置类型                │
└───────────────┬──────────────────────────────────────────────┘
                │ 依赖
┌───────────────▼──────────────────────────────────────────────┐
│ @flash-tunnel/cli (packages/cli)                             │
│ 命令解析 · 交互 · 终端渲染 · JSON · 退出码 · 信号转交          │
└───────┬───────────────────────────────┬──────────────────────┘
        │ 依赖                           │ 依赖
┌───────▼────────────┐        ┌─────────▼──────────────────────┐
│ Core (packages/core)│        │ Config (packages/config)       │
│ 配置加载 · 探测 ·    │        │ defineConfig · 配置类型         │
│ 编排 · 账本 · 清理   │        └─────────┬──────────────────────┘
└───────┬─────────────┘                  │
        │ 依赖契约                        │
┌───────▼────────────┐        ┌─────────▼──────────────────────┐
│ Types              │◄───────│ Adapters                       │
│ 契约 · 事件 · 错误码 │        │ @flash-tunnel/adapter-cloudflare│
└───────▲────────────┘        │ （未来：adapter-frp、adapter-…）│
        │                     └─────────┬──────────────────────┘
┌───────┴────────────┐                  │ 依赖
│ Utils              │◄─────────────────┘
│ HTTP · 进程 · 模板  │
└────────────────────┘
```

依赖方向是单向的：

- `types` 不依赖任何包（可被第三方适配器安全依赖）。
- `utils` 只依赖 Node 内置能力与少量运行时库，不依赖其它工作区包。
- `config` 不依赖任何工作区包，提供 `defineConfig`（identity）与全部配置类型，不读取文件、不加载 env。
- `core` 依赖 `types` + `utils` + `config`，**不**静态依赖任何具体适配器（内置适配器由 CLI 注入）。
- `adapter-*` 依赖 `types`（+ `utils`），不依赖 `core`。
- `cli` 依赖 `core` + `config` + 内置适配器（`@flash-tunnel/adapter-cloudflare`）。
- `flash-tunnel` 只依赖 `cli` + `config`，自身不含业务逻辑，负责 `bin` 与对用户导出。

这条规则保证：第三方适配器永远不会因为核心包的内部重构而被迫升级；用户安装 `flash-tunnel` 就能拿到 CLI 与配置类型。

## 包职责

| 包 | 名称 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `packages/flash-tunnel` | `flash-tunnel` | `bin`、对用户导出 `defineConfig`/配置类型、把 CLI 与 config 组合成可安装入口 | 业务编排、命令实现 |
| `packages/cli` | `@flash-tunnel/cli` | 命令与参数、交互、终端渲染（`styleText` 主题、spinner 步骤行、`@inquirer/prompts`）、JSON、退出码、信号处理 | 资源编排细节、`bin` |
| `packages/config` | `@flash-tunnel/config` | `defineConfig`、`FlashTunnelConfig` 及子类型、用户可 import 的配置契约 | 读取文件、合并 env、启动进程 |
| `packages/core` | `@flash-tunnel/core` | 配置加载（unconfig）、探测、启动本地服务、适配器编排、资源账本、清理与 reaper、事件 | 解析 CLI 参数、渲染终端 UI |
| `packages/types` | `@flash-tunnel/types` | 适配器契约、事件与错误码、`defineDnsAdapter`/`defineTunnelAdapter` 类型工具 | 用户配置类型（在 config）、运行时副作用 |
| `packages/utils` | `@flash-tunnel/utils` | HTTP 客户端封装、进程启动/停止、ANSI 清理、模板渲染、随机名、状态文件读写、脱敏 | 业务编排 |
| `packages/adapter-cloudflare` | `@flash-tunnel/adapter-cloudflare` | `cloudflareDns` 与 `cloudflareTunnel` 两个适配器实现、Cloudflare API 客户端 | 启动本地服务、决定域名 |

包数量从 5 增加到 7，是为满足「`npx flash-tunnel` 可用 + 可安装后 import 配置类型 + CLI 可编程复用」三个入口；`server` 探测与运行仍放在 `core` 内（`core/src/server/*`），不单独拆包。

## 运行时主流程

```text
CLI: flash-tunnel
  │
  ├─ 1. 解析参数 ──► 载入配置（unconfig，flash-tunnel.ts）──► 合并 env/CLI
  │
  ├─ 2. 恢复检查 ──► 读取 ~/.flash-tunnel/sessions/*.json
  │                     └─ 有本项目的 stale 会话？→ 尝试清理（可用 --no-sweep 关闭）
  │
  ├─ 3. 解析适配器 ──► tunnel = cloudflareTunnel
  │                     dns    = tunnel.requiresDns ? cloudflareDns : undefined
  │                     └─ 组合校验（能力/供应商亲和性）
  │
  ├─ 4. 探测本地服务 ──► 复用已运行服务 or 生成启动计划（命令/端口/就绪规则）
  │
  ├─ 5. 账本登记 server ──► 启动并等待就绪 ──► 得到 http://127.0.0.1:PORT
  │
  ├─ 6. 账本登记 tunnel ──► tunnel.provision()（创建隧道 + ingress 配置）
  │
  ├─ 7. 账本登记 dns ─────► dns.ensure()（CNAME → <tunnelId>.cfargotunnel.com）
  │
  ├─ 8. tunnel.start() ──► 拉起 cloudflared（token 走环境变量）
  │
  ├─ 9. 就绪验证 ────────► 隧道 healthy + 公网 HTTPS 探测通过
  │
  ├─ 10. 输出链接 ──────► 打印/打开浏览器/写 ready 文件/JSON
  │                        └─ 配置了 autoStopAfter 则启动计时器
  │
  └─ 11. 等待退出 ──────► 信号/子进程退出/autoStop 到期/错误 ──► 账本 LIFO 回滚 ──► 退出码
```

## 状态机

```text
idle
 └─► loading-config
      └─► resolving-providers
           └─► detecting-server
                └─► starting-server ──► server-ready
                                          └─► provisioning-tunnel
                                               └─► configuring-ingress
                                                    └─► creating-dns
                                                         └─► launching-tunnel
                                                              └─► verifying
                                                                   ├─► running
                                                                   └─► failed
                                                                        └─► rolling-back
                                                                             └─► done
running ──(退出/信号/子进程退出/错误)──► tearing-down ──► done
```

| 状态 | 进入条件 | 失败去向 |
| --- | --- | --- |
| `loading-config` | 启动 | 直接 `done`（退出码 2） |
| `resolving-providers` | 配置就绪 | `done`（无资源可回滚） |
| `detecting-server` | 适配器就绪 | `done` |
| `starting-server` | 启动计划就绪 | `done`（若已 spawn 则先停止） |
| `provisioning-tunnel` | 本地服务 ready | `rolling-back` |
| `configuring-ingress` | 隧道创建成功 | `rolling-back` |
| `creating-dns` | ingress 配置成功 | `rolling-back` |
| `launching-tunnel` | DNS 已创建 | `rolling-back` |
| `verifying` | cloudflared 已启动 | `rolling-back` |
| `running` | 公网验证通过 | `tearing-down` |
| `tearing-down` | 任意退出入口 | `done`（清理失败也继续，只影响退出码） |

状态与当前步骤由 `core` 维护，并通过事件发出；CLI 只渲染。**任何状态都允许被信号打断**，由账本决定回滚范围（见 08 文档）。

## 资源账本

账本是有序数组，每个条目是一个可补偿的资源：

```ts
interface LedgerEntry<T = unknown> {
  kind: 'server' | 'tunnel' | 'dns' | 'tunnel-process'
  /** 供应商 id，例如 cloudflare */
  provider: string
  /** 资源在供应商侧的标识，用于清理与幂等判断 */
  ref: T
  /** 归属标记：会话 id + 创建时间 + 工具版本 */
  origin: { sessionId: string, createdAt: number, version: string }
  /** 是否由本会话创建（复用来的资源为 false，不清理） */
  owned: boolean
  /** 补偿动作，必须幂等 */
  dispose: () => Promise<void>
}
```

规则：

1. 先登记、后执行可失败操作的前置检查；实际创建成功后立即补全 `ref` 并落盘状态文件。
2. 回滚按**逆序**执行，单个 `dispose` 失败不阻断后续条目。
3. `owned: false` 的条目只做「解除引用」，不销毁（例如复用的 dev server）。
4. 每个 `dispose` 必须自行处理「资源已不存在」（404/进程已退出）并视为成功。
5. 账本持久化到状态文件后，崩溃恢复才有依据（见 08）。

## 事件模型

```ts
interface FlashTunnelEvents {
  'state': { from: State, to: State }
  'log': { level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string }
  'server:detected': { command: string, cwd: string, confidence: 'high' | 'low', reason: string }
  'server:ready': { url: string, port: number, startedByUs: boolean, durationMs: number }
  'tunnel:provisioned': { tunnelId: string, name: string }
  'tunnel:connected': { connections: number }
  'dns:created': { hostname: string, recordId: string, zoneId: string }
  'public:ready': { url: string, verifyMs: number }
  'autostop:expired': { expiresAt: number }
  'cleanup:step': { kind: string, status: 'start' | 'ok' | 'skip' | 'error', detail?: string }
  'cleanup:done': { ok: boolean, removed: string[], failed: Array<{ kind: string, error: string }> }
}
```

`core` 导出一个极小的类型化 `Emitter`（不引第三方事件库），CLI 订阅后决定样式；`--json` 模式下事件被序列化为逐行 JSON（NDJSON）。

## 扩展点

| 扩展点 | MVP | 契约 | 后续 |
| --- | --- | --- | --- |
| 隧道控制 | Cloudflare Tunnel | `TunnelAdapter` | frp、ngrok、bore |
| 域名控制 | Cloudflare DNS | `DnsAdapter` | DNSPod、阿里云 DNS、Route53 |
| 本地服务 | 内置探测 + 启动 | 内部接口（后续可暴露） | 自定义 runner、Docker Compose |
| 通知/输出 | 终端步骤行（spinner）+ 浏览器 + 剪贴板 | CLI UI 层 | 桌面通知、Webhook、二维码 |
| 状态存储 | 本地文件 | `StateStore` | 项目级 `.flash-tunnel/`、系统 keychain |

## 关键决策

| # | 决策 | 理由 | 影响 |
| --- | --- | --- | --- |
| D1 | 使用 **remotely-managed** 隧道（`config_src: cloudflare`） | ingress 走 API，不需要 `cert.pem`、不需要 `cloudflared tunnel login` | 少一步交互、易清理；隧道配置以服务端为准 |
| D2 | 通过 REST API 创建隧道，而不是 `cloudflared tunnel create` | 可拿到结构化 id/token，失败可回滚 | 依赖 Token 权限；需要 `Account: Cloudflare Tunnel: Edit` |
| D3 | DNS 与隧道分成两个适配器 | 支持「CF 域名 + 别家隧道」，也给未来留口 | 需要组合校验与能力矩阵（03） |
| D4 | 资源账本 + LIFO 回滚 + 独立 reaper | 清理是产品核心承诺，不能只靠 `finally` | 复杂度集中在 08 文档 |
| D5 | 默认随机子域名；固定名由用户写死模板 | 避免 DNS/浏览器缓存与并发冲突；随机名天然隔离 | 默认链接每次不同；崩溃后固定名靠「本工具记录自动回收」自愈 |
| D6 | 配置只认 `flash-tunnel.ts`，用 unconfig | 与生态（UnoCSS/Nuxt 等）一致；避免多格式解析分支 | 不提供 `.js`/`.mjs`/`package.json` 配置 |
| D7 | 七包结构（flash-tunnel / cli / config / core / types / utils / adapter-cloudflare） | 用户入口（npx、import 配置）与实现（cli、config）分离；第三方适配器只依赖 types | 包更多，但三个入口各自稳定；后续不因入口调整破坏类型 |
| D8 | npx 场景对 `defineConfig` 做加载期 shim | 用户不安装包也能写带类型的配置 | 需要 transform 重写 import（06） |
| D9 | 配置面收敛为 15 字段，只做覆盖 | 默认必须可推导；避免把能力/安全开关写进仓库 | 凭据、清理、UI、DNS 细节不进配置（06） |
| D10 | 终端 UI 用 `styleText` + `yocto-spinner`（关闭信号接管）+ `@inquirer/prompts` | 颜色零依赖、spinner 把 SIGINT 所有权留给清理、交互体验完整 | 禁止 chalk/picocolors/ora；UI 只存在于 CLI 层（07、11） |

## 失败域划分

| 失败域 | 典型原因 | 处理 | 是否回滚已建资源 |
| --- | --- | --- | --- |
| 配置/参数 | 非法字段、无法解析 TS、缺少 Token | 立即报错并给出修复建议 | 否 |
| 本地服务 | 命令不存在、端口占用、启动超时、构建产物缺失 | 报错并输出最后 50 行日志 | 否（仅停掉自己起的进程） |
| 隧道创建 | Token 权限不足、账号/Zone 不匹配、限流 | 映射错误码，提示缺少的权限 | 删除已创建的前序资源 |
| ingress 配置 | 主机名非法、多级子域证书限制 | 报错并给出命名建议 | 删除隧道 |
| DNS | 记录冲突、Zone 非 Active、Token 无 DNS 权限 | 报错，提示冲突记录 | 删除隧道 |
| cloudflared 启动 | 二进制缺失、版本过旧、连接被拒 | 提示安装/升级命令 | 删除 DNS + 隧道 |
| 公网验证 | 隧道未连上、源站 5xx、代理缓存 | 超时后报错并附诊断信息 | 删除全部 |
| 清理 | API 5xx、连接未断开、网络中断 | 重试 + reaper + 下次启动扫描 | 不适用 |

## 代码结构（core 视角）

```text
packages/core/src/
├─ index.ts                 # createFlashTunnel / runFlashTunnel
├─ config/                  # unconfig 加载、默认值、校验、模板
├─ adapters/                # 注册表、加载、组合校验
├─ server/                  # detect、package-manager、spawn、probe、static
├─ session/                 # 状态机、ledger、state-store、reaper、sweep
├─ events.ts
└─ errors.ts                # FlashTunnelError + 错误码
```

每个子目录只通过 `index.ts` 暴露必要符号，禁止跨目录深引用。
