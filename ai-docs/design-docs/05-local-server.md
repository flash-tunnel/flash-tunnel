# 05 · 本地服务识别与运行

`flash-tunnel` 自身不提供业务服务（除静态模式内置的极简静态服务器），它负责**找到**项目该怎么跑、**拉起**它、**等它可用**，然后把地址交给隧道。

## 运行模式由字段推断

没有 `server.type` 枚举。写了什么，就按什么模式运行：

| 配置 | 行为 | 是否由本工具启动 | 退出时是否停止 |
| --- | --- | --- | --- |
| 什么都没写 | 自动探测脚本/框架 | 通常是 | 是（仅自己启动的） |
| `command` | 用该命令启动；`url` 可选，作为期望地址 | 是 | 是 |
| 只有 `url` | 直接复用已运行服务 | 否 | 否 |
| 只有 `dir` | 内置静态服务器托管该目录 | 是（内置） | 是 |
| `command` + `dir` / `url` + `dir` | 校验错误（互相矛盾） | — | — |

CLI 的 `--command`、`--url`、`--static [dir]`、`--attach` 分别对应上述字段；`--attach` 必须配合 `--url`。

## 探测流程

```text
1. 显式配置
   ├─ command 存在        → 用它启动（url 作为期望地址）
   ├─ 只有 url            → 校验可达后复用
   └─ 只有 dir            → 静态模式

2. 读取 package.json（cwd 或 server.cwd）
   ├─ scripts.preview → 首选 preview（需产物）
   ├─ scripts.dev     → 次选 dev
   ├─ scripts.start   → 再次
   └─ 无 scripts      → 进入第 4 步

3. 框架/依赖识别（只用于默认端口与提示，不改变脚本选择）
   └─ vite/next/nuxt/astro/... → 记录默认端口与已知坑

4. 兜底
   ├─ dist/build/out/public 含 index.html → 静态模式
   ├─ pnpm workspace 根目录 → 列举子包候选（TTY 选择；非 TTY 提示 --cwd）
   └─ 都失败 → 报错并给出「设置 server.command」的示例
```

### preview 与 dev 的默认取舍

`preview` 服务构建产物，更接近「给别人看的最终效果」，不暴露 HMR、source map、调试接口。所以默认：

- `preview` 且产物存在 → 用 preview。
- `preview` 存在但产物缺失，且存在 `dev` → **自动降级 dev**，步骤行标注「preview 产物缺失，已改用 dev」。
- `preview` 存在、产物缺失、也没有 `dev` → 报错并建议 `--build`（先 `pnpm build` 再 preview）。
- 只有 `dev` → 用 dev，面板标注「开发模式，包含 HMR 与调试接口」。
- 想强制 dev：`--dev` 或 `server.command: 'pnpm dev'`。

产物目录探测顺序：`dist` → `build` → `out`。只认含 `index.html` 的目录。

### 包管理器解析

1. `package.json#packageManager`（如 `pnpm@12.4.2`）→ 取名字部分。
2. 锁文件：`pnpm-lock.yaml` → pnpm；`yarn.lock` → yarn；`bun.lock`/`bun.lockb` → bun；`package-lock.json`/`npm-shrinkwrap.json` → npm。
3. 都没有 → `npm`。

| 包管理器 | 命令 |
| --- | --- |
| pnpm | `pnpm run <script>` |
| yarn | `yarn run <script>` |
| npm | `npm run <script>` |
| bun | `bun run <script>` |

Windows 上 spawn `.cmd` 需要 `shell: true`（或 `cross-spawn` 语义），否则 `ENOENT`。这类调用统一走 `@flash-tunnel/utils` 的 `shellInvocation()`：Windows 下把命令与参数拼成一条转义后的命令行，避免 `shell: true` + `args` 数组触发 Node 的 DEP0190 警告。

### 框架默认端口

| 框架 | dev 端口 | preview 端口 | 备注 |
| --- | --- | --- | --- |
| Vite | 5173 | 4173 | 端口被占会自动 +1；必须解析输出 |
| Next.js | 3000 | 3000 | `next start` 需先 build；`next dev` 有 `allowedDevOrigins` |
| Nuxt | 3000 | 3000 | `nuxt preview` 需先 build |
| Astro | 4321 | 4321 | preview 需先 build |
| SvelteKit | 5173 | 4173 | 与 Vite 一致 |
| Vue CLI | 8080 | — | |
| Create React App | 3000 | — | |
| Angular | 4200 | — | |
| Storybook | 6006 | — | 纯展示，适合分享 |
| Umi | 8000 | — | |

端口表只用于「没解析到输出时的兜底」，不能替代输出解析：Vite 在 5173 被占时会用 5174。

### Vite 的 Host 校验

Vite 6.0.9+ 默认拒绝非 `localhost`、IP、`.localhost` 的 Host（防 DNS rebinding），隧道域名会收到 `Blocked request. This host ... is not allowed.`。

flash-tunnel 启动 dev server 时自动注入 `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`：

- named 模式 → 固定的隧道 hostname；
- quick 模式 → `.trycloudflare.com`（Vite 的 `.` 前缀表示该域及全部子域）。

该变量由 Vite 6.1 起支持（6.1–8.0 只接受单个 host，8.1 起才支持逗号分隔）；`vite preview` 继承 `server.allowedHosts`，同样生效。用户显式设置该变量时不覆盖。Vite < 6.1 无法自动放行，公网探测到 Vite 拦截页时会报 `PUBLIC_HOST_BLOCKED`，并提示把 hostname 写进 `server.allowedHosts`。

## 端口与地址解析

优先级：

1. 输出中解析到的 URL。
2. 配置 `server.url`（同时作为复用地址与期望地址）。
3. 配置 `server.port`。
4. 脚本参数中的 `--port N` / `-p N` / `PORT=N`。
5. 框架默认端口。
6. 端口被占用时：静态模式自动找下一个空闲端口；其它模式进入冲突处理。

输出解析（ANSI 已剥离）：

```text
/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?/i
```

- `0.0.0.0` 归一化为 `127.0.0.1`。
- 优先 `Local:` 行，忽略 `Network: http://192.168.x.x:5173`。
- 只打印端口（`Listening on 3000`）时与默认端口表交叉验证。

## 就绪判定

```ts
async function waitReady(plan, signal): Promise<ReadyResult> {
  // 1) 监听子进程输出，匹配到 URL 立即记录候选
  // 2) 每 300ms 探测候选端口：TCP connect + HTTP GET（接受任意状态码，连接被拒才算未就绪）
  // 3) 子进程提前退出 → 立即失败，附退出码与最后 50 行日志
  // 4) 超时（默认 server.timeout = 60s）→ 停止进程并报错
}
```

接受任意 HTTP 状态码的理由：401/403/404 都说明「服务已监听并响应」；这一层只判断可达性，内容正确性交给公网验证。

超时错误携带：命令、cwd、脱敏后的关键环境变量、最后 N 行输出、端口探测结果，以及 `--verbose` / `server.command` / `--build` 的建议。

## 复用已运行服务

默认策略：

| 情况 | 行为 |
| --- | --- |
| 只有 `url`（CLI `--url`/`--attach`） | 可达则复用，不停止 |
| `command` + `url` | 启动命令，用 `url` 作为期望地址（不因端口占用而误判） |
| 探测端口被占用 | TTY：询问「复用 / 换端口 / 退出」；非 TTY：报错并提示 `--reuse` |
| 同项目已有会话运行 | 报错，提示先停止旧会话（不允许同项目并发两个会话） |

复用时不修改、不重启、不停止用户服务；退出只断开隧道。CLI `--reuse` 跳过询问直接复用。

## 静态模式

内置静态服务器（`core/src/server/static.ts`）刻意保持最小：

- 目录：`server.dir` / `--static [dir]` / 自动探测 `dist`→`build`→`out`→`public`。
- MIME：html/js/css/json/svg/png/jpg/webp/woff2/wasm/map 等；未知按 `application/octet-stream`。
- SPA 回退：路径不存在且 `Accept: text/html` 时返回 `index.html`（固定行为，无开关）。
- 安全：拒绝 `..` 穿越；不列目录；只监听 `127.0.0.1`。
- 缓存：MVP 统一 `no-store`。
- 不实现：Range、gzip/br（交给 Cloudflare）、SSE。

端口默认 4173；被占用则递增寻找空闲端口。

## 进程管理

```ts
interface ServerHandle {
  pid?: number
  url: string
  startedByUs: boolean
  child?: ChildProcess
}
```

启动参数：

- `cwd`: 项目根或 `server.cwd`。
- `env`: 继承 `process.env`，注入 `FLASH_TUNNEL=1`。不提供 `server.env` 配置——需要变量请写进 npm script 或 `.env`（由框架加载）。
- `stdio`: `['ignore', 'pipe', 'pipe']`；输出转发到 UI（verbose）并写日志文件。
- POSIX `detached: true` 启动独立进程组；Windows 默认进程 + `taskkill /T`。

停止：

```text
if (!startedByUs) return
SIGTERM 进程树 → 等待 5s → SIGKILL 进程树
Windows: taskkill /PID <pid> /T /F
```

必须处理：子进程已退出、停止失败只警告、Windows 进程被系统收养（靠状态文件在下次启动识别）。

## 日志

| 位置 | 内容 | 生命周期 |
| --- | --- | --- |
| 终端 | 步骤行 + 关键错误；`--verbose` 透传子进程输出（关闭 spinner） | 会话期间 |
| `~/.flash-tunnel/projects/<key>/logs/server-<sessionId>.log` | 完整 stdout/stderr（时间戳 + 流标记） | 最近 10 个会话且不超过 7 天 |
| `~/.flash-tunnel/projects/<key>/logs/tunnel-<sessionId>.log` | cloudflared 输出 | 同上 |
| 状态文件 | 命令、cwd、端口、pid | 会话结束删除 |

日志中 Token/`Authorization` 一律替换为 `***`；`--json` 不输出日志正文。

## 常见失败与提示

| 现象 | 原因 | 提示 |
| --- | --- | --- |
| `ENOENT` | 包管理器/命令不存在 | 检查 PATH 或设置 `server.command` |
| 端口占用且无响应 | 残留进程 | `netstat`/`lsof` 提示 + `--port` |
| 启动后立刻退出 | 脚本错误、缺依赖 | 展示最后 50 行输出 |
| 一直不 ready | 需交互登录、卡在编译 | `--verbose`，或 `--static` 托管已构建产物 |
| preview 无产物 | 未构建 | 自动降级 dev；无 dev 时提示 `--build` |
| 公网 403 `Blocked request` | Vite `allowedHosts` | 在 `vite.config.ts` 加 `server.allowedHosts: ['.example.com']`，或用 Cloudflare `originRequest.httpHostHeader` |
| 页面能开但 HMR 连不上 | Vite HMR 端口/协议 | `server.hmr.clientPort = 443`（或 `protocol: 'wss'`） |
| Next dev 拒绝来源 | `allowedDevOrigins` | 提示加入公网域名 |
