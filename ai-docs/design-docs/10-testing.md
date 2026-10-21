# 10 · 测试策略

## 分层

| 层 | 范围 | 依赖 | 运行频率 |
| --- | --- | --- | --- |
| 单元测试 | 模板、探测、配置校验、账本、错误映射、状态文件 | 无网络、无真实进程 | 每次提交 |
| 契约测试 | 适配器是否符合 `DnsAdapter`/`TunnelAdapter` | fake 客户端 | 每次提交（内置）+ 第三方发布前 |
| 集成测试（mock） | core 编排 + mock HTTP + 真实子进程（node 脚本） | 本地端口 | 每次提交 |
| 端到端（真实） | 真实 Cloudflare 账号 | 网络 + 凭据 | 手动 / nightly |

目标覆盖率：`core` 行覆盖 ≥ 80%，`adapter-cloudflare` ≥ 70%，`cli` 以行为测试为主（不追求行覆盖）。

## 单元测试

### 配置（core/config）

- 只加载 `flash-tunnel.ts`：存在 `.js`/`.mjs` 时**不应**被读取。
- 向上查找：项目内优先于仓库根。
- 默认值合并、CLI/env 覆盖优先级。
- 默认推导链：唯一 Zone / 多 Zone 报错、account/zone id、preview→dev 降级、端口来源。
- `--dry-run` 的来源标注（`default/detected/env/config/inferred`）与字段顺序。
- 模板渲染：`{project}`/`{branch}`/`{rand:N}`/`{session}`；slug 规则；长度截断。
- 主机名校验：超长、非法字符、多级子域（`--allow-multilevel`）、通配符拒绝。
- `autoStopAfter` 解析：`'2h'`/`'90s'`/毫秒数/非法值；最小粒度 1s。
- 错误路径：语法错误、默认导出缺失、未知字段告警、类型错误。
- 不存在被移除的字段：`cleanup`、`ui`、`hooks`、`server.type`、`dns.*`（类型层面应直接编译失败）。
- `defineConfig` shim：配置里 `import { defineConfig } from 'flash-tunnel'`（以及 `flash-tunnel/config`）在「未安装该包」的临时目录也能加载（用 fixture + 重写后的 shim 路径）。
- 三个入口一致性：`flash-tunnel`、`flash-tunnel/config`、`@flash-tunnel/config` 导出的 `defineConfig` 是同一个 identity 函数，类型同源。

### 探测（core/server）

fixture 项目目录覆盖：

| fixture | 期望 |
| --- | --- |
| vite + `dev` + `preview` + 产物 | 选 preview |
| vite + `preview` 无产物 + `dev` | 降级 dev，带提示 |
| 只有 `preview` 且无产物 | 报错并提示 `--build` |
| 只有 `dev` | 选 dev，标注开发模式 |
| 无 scripts + `dist/index.html` | static，端口 4173 |
| pnpm-lock + packageManager | 命令为 `pnpm run dev` |
| yarn.lock | `yarn run dev` |
| 无锁文件 | `npm run dev` |
| monorepo 根 + 两个子包 | 交互候选；非 TTY 提示 `--cwd` |
| 端口被占用 | 询问；`--reuse` 直接复用；非 TTY 报错 |
| 输出解析 | ANSI 包裹的 `Local: http://localhost:5174/` → 5174 |
| `url` 显式配置 | 不启动，直接探测复用 |

就绪探测测试用真实子进程（`node -e "server.listen(0)"`）验证 TCP/HTTP 探测与超时；用假进程验证「提前退出」路径。

### 账本与清理（core/session）

- 逆序回滚：记录 `dispose` 调用顺序。
- 单个 `dispose` 抛错不影响其余条目，最终 `ok=false`。
- 超时预算：用 fake timers 验证总预算生效。
- 状态文件原子写：写入中断后旧文件仍可读（模拟 rename 前进程退出）。
- 幂等：连续清理两次，第二次全部走 404/已停止分支。
- 归属校验：comment 不匹配时拒绝删除。
- 锁：并发获取第二个失败；stale lock（pid 不存在）可回收。

### Cloudflare 适配器

用 `undici` 的 `MockAgent`（Node 内置）拦截 `api.cloudflare.com`：

```ts
const agent = new MockAgent()
agent.disableNetConnect()
const client = agent.get('https://api.cloudflare.com')

client.intercept({ path: '/client/v4/user/tokens/verify', method: 'GET' })
  .reply(200, { success: true, result: { status: 'active' } })
```

用例：

- Token 无效（success=false, 401）→ `AUTH_INVALID`。
- 多账号未指定 accountId → `ACCOUNT_NOT_FOUND` 且提示配置。
- Zone 不存在 / 非 active。
- 记录冲突 → `RECORD_CONFLICT`；带本工具 comment 的同名记录自动回收；`--overwrite` 时才覆盖他人记录。
- 创建隧道成功但响应无 token → 自动调用 `/token`。
- ingress 缺少 catch-all → 本地校验先行拦截（不发请求）。
- 删除隧道遇「仍有连接」→ 先清理 connections 再重试一次。
- 429 → 按退避重试 N 次后失败（fake timers）。
- 清理时 404 → 成功。
- 日志脱敏：请求头中的 Bearer 不出现在日志（断言）。

fixture 文件放 `packages/adapter-cloudflare/test/fixtures/*.json`，与真实 API 响应结构一致；首次实现后用真实账号抓一份响应校准。

### CLI 与终端 UI

- 参数解析：默认命令、别名、未知参数退出码 2；互斥参数（`url`+`dir`）报错。
- `--json`：stdout 仅有 NDJSON、stderr 有人类日志、无 ANSI。
- 退出码映射：各失败域注入 core 错误，断言码；autoStopAfter 为 0。
- 非 TTY：不进入交互，冲突直接失败；不启动 spinner。
- 颜色：`NO_COLOR=1` 无转义；`FORCE_COLOR=1` 有转义；`--no-color` 等价。
- 通道：`styleText` 必须按目标 stream 校验（stdout 管道 + stderr TTY 时 stderr 仍有颜色）。
- 符号：Windows conhost 降级为 ASCII；`WT_SESSION` 下用 Unicode。
- 步骤行：成功/失败/耗时文本；失败时先停 spinner 再输出错误块。
- spinner：`handleSignals: false`（源码断言）；`--verbose` / `--no-spinner` 不创建实例。
- prompts：`ExitPromptError` 转换为退出码 130；非交互环境不调用 prompt。
- `doctor --json`：检查项结构稳定。

UI 测试不要做完整彩色快照：用 `--no-color` 断言行文本，用 `FORCE_COLOR=1` 单独断言「包含 SGR」即可，避免 Node 版本差异导致脆弱。

CLI 测试不启动真实网络；通过依赖注入替换 `runFlashTunnel`。

## 适配器一致性测试

计划发布 `@flash-tunnel/testing`（M4），导出：

```ts
import { describeDnsAdapter, describeTunnelAdapter } from '@flash-tunnel/testing'

describeDnsAdapter({
  name: 'cloudflare',
  createAdapter: () => cloudflareDns,
  fakeClient, // 注入 API mock 与 zone/记录状态机
})

describeTunnelAdapter({
  name: 'cloudflare',
  createAdapter: () => cloudflareTunnel,
  fakeClient,
})
```

套件断言：

- `preflight` 无副作用（调用前后 fake 状态不变）。
- `ensure` 幂等（连续两次返回同一 ref，不产生第二条记录）。
- `remove` 幂等（第二次不抛错）。
- `deprovision` 在资源不存在时成功。
- `waitReady` 超时抛 `TUNNEL_NOT_CONNECTED` 且可被中断。
- 能力声明与行为一致（例如声明 `requiresDns: false` 时 `handle.dns` 必须为空）。

第三方适配器可直接复用该套件，保证组合可用。

## 集成测试（mock）

在临时目录构造项目，跑完整编排：

```ts
const dir = await fs.mkdtemp(join(tmpdir(), 'ft-'))
await fs.writeFile(join(dir, 'package.json'), JSON.stringify({
  scripts: { dev: 'node -e "..."' },
}))
const session = await startFlashTunnel({
  cwd: dir,
  config: { dns: { zone: 'example.com' }, tunnel: { mode: 'named' } },
  adapters: { tunnel: fakeTunnel, dns: fakeDns },
})
```

断言：

- 事件顺序符合状态机（`server:ready` → `tunnel:provisioned` → `dns:created` → `public:ready`）。
- `SIGINT` 后：清理事件顺序、退出码、状态文件消失、fake 适配器收到 stop/remove/deprovision。
- 注入失败：ingress 失败 → 隧道被删；DNS 失败 → 隧道被删；cloudflared 启动失败 → DNS + 隧道被删。

真实子进程测试注意：

- Windows CI 上 `taskkill` 行为与 POSIX 不同，停止逻辑必须有平台分支测试。
- 测试结束清理临时目录与残留进程（`afterEach` 校验无孤儿）。
- 端口使用随机空闲端口，避免并发冲突。

## 端到端测试（真实 Cloudflare）

用环境变量门控：

```bash
FLASH_TUNNEL_E2E=1 \
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
FLASH_TUNNEL_E2E_ZONE=example.com \
pnpm test:e2e
```

流程：

1. 用独立测试 Zone（不要用生产域名）。
2. 启动一个最小 HTTP 服务（返回固定文本），执行 `flash-tunnel`（非交互、`--json`）。
3. 轮询公网 URL 直到返回预期文本（≤ 90s）。
4. 发送退出，等待进程退出。
5. 断言：DNS 记录查询为空、隧道 GET 404、退出码 0。
6. `kill -9` 场景：再次启动，断言扫描自动清理，且新会话成功。

约束：

- 每次运行使用随机子域与独立隧道名，避免与人工调试冲突。
- 失败时保留日志并在 CI artifact 中输出（脱敏）。
- 默认不在 PR 上运行；通过 `workflow_dispatch` 或 nightly 触发。

## 手工验收清单

- [ ] 无配置的 Vite 项目一条命令拿到链接。
- [ ] `Ctrl+C` 后 Cloudflare 控制台无残留。
- [ ] `kill -9` 后重新运行提示并清理上次资源。
- [ ] Token 缺权限时错误可读、无资源创建。
- [ ] `--dry-run` 不产生任何资源。
- [ ] `--json` 输出可被 `jq` 解析。
- [ ] `doctor` 在干净环境与问题环境都给出准确结论。
- [ ] Windows / macOS / Linux 各跑一次（至少 Windows + Linux）。
- [ ] 手机 4G 网络访问链接可用。
- [ ] 隧道运行中断网再恢复，链接恢复可用（cloudflared 自动重连）。

## CI（仅 tag 触发）

```yaml
on:
  push:
    tags: ['v*']
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [22, 24]
```

- 没有 push/PR 触发的 workflow；日常提交不产生 Actions 运行，合并前本地跑同一组命令。
- `release.yaml` 只有一个入口（tag），内部 `verify` job 跑矩阵、`publish` job `needs: verify`。
- `verify` 执行 `pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（单元 + 集成 mock）。先 build 再 typecheck，保证干净 checkout 下 workspace 包的类型产物已存在。
- 单独 job 跑 E2E（nightly，仓库 secrets，仅主仓库）。
- 发布前在干净容器里 `npx flash-tunnel --version` 冒烟，验证 `bin` 与依赖打包正确。
- 首次发布链路单独演练一次：`0.0.0 --tag bootstrap` 占位 → 配置 Trusted Publisher → `0.1.0` tag 发布（详见 11 的发布流程）。
