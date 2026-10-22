# 07 · CLI、终端输出与交互

## 命令总览

| 命令 | 说明 |
| --- | --- |
| `flash-tunnel` / `flash-tunnel start` | 默认：探测 → 启动 → 建隧道 → 输出地址 → 等待退出 |
| `flash-tunnel clean` | 清理遗留资源（按会话/项目/全量），支持 dry-run |
| `flash-tunnel doctor` | 环境体检：Token、权限、Zone、cloudflared、端口、域名冲突、框架坑 |
| `flash-tunnel init` | 生成 `flash-tunnel.ts` 模板与 `.gitignore` 条目 |
| `flash-tunnel providers` | 列出可用适配器与能力矩阵 |
| `flash-tunnel __reap --session <id>` | 内部命令：独立子进程兜底清理，不出现在 help |
| `flash-tunnel --version` / `--help` | 版本与帮助 |

## 参数

### 通用

| 参数 | 说明 |
| --- | --- |
| `-c, --config <path>` | 指定配置文件 |
| `--verbose` | 透传子进程与 API 日志（关闭 spinner） |
| `--json` | 机器可读输出（stdout 仅 NDJSON，人类日志走 stderr） |
| `--silent` | 只输出错误 |
| `--no-color` | 关闭颜色（等价 `NO_COLOR=1`） |
| `--no-spinner` | 关闭动画，保留逐行状态 |
| `--dry-run` | 只做预检与计划，不创建资源，输出生效配置及来源 |
| `-y, --yes` | 非交互；冲突直接失败 |
| `--cwd <path>` | 项目根目录（默认当前目录） |

### 本地服务

| 参数 | 说明 |
| --- | --- |
| `--port <n>` | 期望端口 |
| `--command <cmd>` | 显式启动命令 |
| `--url <url>` | 复用已运行服务（不启动） |
| `--attach` | 强制复用；需配合 `--url` |
| `--static [dir]` | 静态模式（默认自动探测目录） |
| `--build` | preview 前先执行 build |
| `--dev` | 强制使用 dev 脚本 |
| `--reuse` | 端口占用时直接复用（不询问） |

### 隧道与域名

| 参数 | 说明 |
| --- | --- |
| `--zone <domain>` | 主域名（Zone） |
| `--hostname <fqdn>` | 完整主机名（跳过 zone/模板） |
| `--subdomain <label>` | 子域模板或字面量 |
| `--mode <named\|quick>` | 隧道模式 |
| `--tunnel-provider <id>` | 隧道适配器 |
| `--dns-provider <id>` | DNS 适配器 |
| `--auto-stop <dur>` | 到期自动停止并清理，如 `2h`、`30m` |
| `--allow-multilevel` | 允许多级子域（需 Advanced Certificate） |
| `--overwrite` | 覆盖**非本工具创建**的同名记录（高危） |

### 清理与输出

| 参数 | 说明 |
| --- | --- |
| `--keep` | 退出时保留 DNS 与隧道（调试用，显著警告并打印手动清理命令） |
| `--no-sweep` | 启动时不扫描遗留会话 |
| `--ready-file <path>` | 就绪后写入结果 JSON |
| `--on-ready <cmd>` | 就绪后执行命令，注入 `FLASH_TUNNEL_URL` 等环境变量 |
| `--no-open` | 不自动打开浏览器 |

## 输出

### 人类模式（TTY）

```text
flash-tunnel v0.0.0  ·  flash-tunnel.ts

✔ 配置        example.com · 随机子域
✔ 本地服务    pnpm dev → http://127.0.0.1:5173              1.2s
✔ 隧道        cloudflare/named  flash-tunnel-my-app-k3f9     3.1s
✔ 域名        my-app-k3f9.example.com  CNAME → k3f9…cfargotunnel.com  0.4s
✔ 验证        200 OK                                         2.4s

  Preview  https://my-app-k3f9.example.com
  已复制到剪贴板 · 4h 后自动停止（20:52）· Ctrl+C 退出并清理
```

颜色约定（`node:util` 的 `styleText`）：

| 元素 | 样式 |
| --- | --- |
| 成功符号 / 成功步骤 | `bold` + `green` |
| 失败符号 / 失败步骤 | `bold` + `red` |
| 警告 | `bold` + `yellow` |
| 信息 | `blue` |
| 强调值（域名、供应商） | `cyan` |
| URL | `bold` + `cyan` + `underline` |
| 耗时、来源、提示 | `gray`（dim） |

规则：

- **不只靠颜色传达含义**：每个状态都有符号（`✔ ✖ ⚠ ℹ`），颜色是增强。
- URL 单独一行、无前缀，保证终端能识别为可点击链接；不在 URL 后紧跟标点。
- 耗时统一格式：`<1000ms` 显示 `850ms`，否则 `1.2s`，超过 1 分钟显示 `1m 3s`。
- 关闭颜色时符号与文字仍完整可读。

### 非 TTY / CI（逐行模式）

```text
flash-tunnel: server ready http://127.0.0.1:5173 (pnpm dev)
flash-tunnel: tunnel healthy flash-tunnel-my-app-k3f9
flash-tunnel: dns created my-app-k3f9.example.com
flash-tunnel: preview https://my-app-k3f9.example.com
```

- 不输出 ANSI，不启动 spinner，不做交互。
- 每行一个事实，方便 `grep`；失败行以 `flash-tunnel: error <code> <message>` 输出。

### 失败

```text
✖ 域名记录创建失败  [DNS_RECORD_CREATE_FAILED]
  原因  Cloudflare API 返回 81057: The record already exists.
  处理  1) 换一个子域：--subdomain {project}-{rand}
        2) 确认旧记录可删后重试：--overwrite
  文档  ai-docs/design-docs/04-cloudflare.md

正在回滚 …
✔ 已删除隧道 flash-tunnel-my-app-k3f9
✔ 已删除 DNS 记录 my-app-k3f9.example.com
```

失败时先停掉 spinner，再打印错误块；回滚过程继续用步骤行展示。

### JSON 模式

stdout 逐行 NDJSON；人类日志与 spinner 全部走 stderr：

```json
{"type":"server:ready","localUrl":"http://127.0.0.1:5173","command":"pnpm dev","durationMs":1234}
{"type":"dns:created","hostname":"my-app-k3f9.example.com","recordId":"...","zoneId":"..."}
{"type":"ready","url":"https://my-app-k3f9.example.com","hostname":"my-app-k3f9.example.com","tunnelId":"...","sessionId":"ft_m3k9x_7fa2","expiresAt":"2026-10-21T20:52:00.000Z"}
{"type":"cleanup","ok":true,"removed":["dns","tunnel","process"],"failed":[]}
{"type":"exit","code":0}
```

- `type` 是对外稳定契约，由 CLI 从内部事件映射（`public:ready` → `ready`，`cleanup:done` → `cleanup`）。
- 失败时输出 `{"type":"error","code":"...","message":"...","hint":"..."}` 后退出。
- `--ready-file` 的内容是 `type: "ready"` 的对象。

## 终端 UI 实现

### 颜色：`node:util` 的 `styleText`

```ts
import { styleText } from 'node:util'

const output = process.stdout // --json 时改为 process.stderr
const paint = (style: Parameters<typeof styleText>[0], text: string) =>
  styleText(style, text, { stream: output })
```

- Node 20.12+ 提供；从 20.18+ 起自动尊重 `isTTY`、`NO_COLOR`、`NODE_DISABLE_COLORS`、`FORCE_COLOR`。项目基线 `>=22.14` 可直接使用，不需要 chalk/picocolors。
- **必须传 `{ stream }`**：默认按 stdout 判断 TTY。`--json` 模式下人类日志写 stderr，若 stdout 被管道重定向而 stderr 是终端，不传 stream 会把颜色误判为关闭。
- 只用 16 色与常用修饰（`bold`/`dim`/`underline`），不用 hex（Node 24.16+ 才支持）和 `'none'`（22.17+）。
- 组合样式用数组：`styleText(['bold', 'cyan'], url)`；数组里的颜色后者覆盖前者。
- 主题集中在一个模块，禁止在业务代码里直接写 ANSI：

```ts
// packages/cli/src/ui/theme.ts
export const theme = {
  ok: (s: string) => paint(['bold', 'green'], s),
  err: (s: string) => paint(['bold', 'red'], s),
  warn: (s: string) => paint(['bold', 'yellow'], s),
  info: (s: string) => paint('blue', s),
  accent: (s: string) => paint('cyan', s),
  url: (s: string) => paint(['bold', 'cyan', 'underline'], s),
  dim: (s: string) => paint('gray', s),
  bold: (s: string) => paint('bold', s),
}
```

### 符号

```ts
const unicode = process.platform !== 'win32'
  || Boolean(process.env.WT_SESSION)
  || process.env.TERM_PROGRAM === 'vscode'

export const symbols = unicode
  ? { ok: '✔', fail: '✖', warn: '⚠', info: 'ℹ', bullet: '·', arrow: '→' }
  : { ok: '√', fail: '×', warn: '!', info: 'i', bullet: '-', arrow: '->' }
```

### Spinner：对比与选择

| 库 | 版本 | 月下载 | 依赖 | 信号处理 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `nanospinner` | 1.2.2 | ~12.7M | `picocolors` | `start()` 挂 `SIGINT`/`SIGTERM`，回调里直接 `process.exit(130/143)`，无关闭选项 | 不可用（除非手动调 `spin()` 绕开 `start()`，属于非常规用法） |
| `picospinner` | 3.1.2 | ~11.5M | 无 | `start()` 总是挂 `SIGINT`/`SIGTERM`，回调里 `process.exit()`，无关闭选项 | 不可用 |
| `yocto-spinner` | 1.2.2 | ~53M | `yoctocolors` | 提供 `handleSignals: false`；默认写 stderr；非 TTY 不启动定时器 | **选它** |

原因很直接：`flash-tunnel` 的核心承诺是 `Ctrl+C` 后异步删除 DNS 与隧道。上面两个库的信号处理器会同步 `process.exit()`，把清理流程直接掐断（只能退化到 `process.on('exit')` 的同步 reaper，用户看不到进度，还会阻塞至多 20 秒）。`yocto-spinner` 允许把信号所有权交还给我们，这是硬性要求。

```ts
import yoctoSpinner from 'yocto-spinner'

const spinner = yoctoSpinner({
  stream: output,
  handleSignals: false,   // 关键：SIGINT 由我们处理，先清理再退出
  color: 'cyan',
})
```

其它细节：

- 非 TTY 不启动 spinner（由 UI 层判断），避免 CI 日志被动画帧刷屏。
- `--verbose` 时关闭 spinner，直接透传子进程输出，避免两套光标控制打架。
- 所有 `spinner.stop()/success()/error()` 必须放在 `finally` 或错误路径里，保证光标恢复（`yocto-spinner` 在 stop 时恢复）。
- 收到 `SIGINT` 时先 `spinner.stop()` 再打印换行，然后进入清理。

### 步骤编排

不引入 listr2 这类重型任务树：流程是严格串行的，自建一个约 40 行的 step runner 即可，且能完全控制 spinner 与错误渲染。

```ts
// packages/cli/src/ui/step.ts
export async function step<T>(
  ui: Ui,
  label: string,
  task: () => Promise<T>,
  summary?: (value: T) => string | undefined,
): Promise<T> {
  const startedAt = performance.now()
  ui.startStep(label)
  try {
    const value = await task()
    ui.endStep('ok', label, startedAt, summary?.(value))
    return value
  }
  catch (error) {
    ui.endStep('fail', label, startedAt)
    throw error
  }
}
```

- 交互模式下：`start` 显示 spinner；`end` 替换为 `✔ label  <耗时>  <摘要>`。
- 非交互模式下：只在结束时打印一行，不输出开始行。
- `phase('清理')` 打印分组标题（空行 + 加粗标题）。
- 失败时 `endStep('fail')` 只输出 `✖ label`，具体错误块由上层统一渲染。

阶段划分与文案（与状态机一致）：

```text
配置 → 本地服务 → 隧道 → 域名 → 验证 →（运行中）→ 清理
```

### 交互：`@inquirer/prompts`

```ts
import { confirm, select } from '@inquirer/prompts'

const zone = await select({
  message: '选择要使用的 Zone',
  choices: zones.map(z => ({ name: `${z.name} (${z.status})`, value: z })),
})
```

- 使用 `select`（Zone/子包/冲突处理）、`confirm`（quick 降级、覆盖记录）、`input`（手动端口/主机名）。
- 仅在 `process.stdin.isTTY && process.stdout.isTTY && !CI && !--yes && !--json` 时启用；否则抛出带修复建议的错误（例如「非交互环境请设置 `--zone`」）。
- `Ctrl+C` 会让 prompt 以 `ExitPromptError` 拒绝（`error.name === 'ExitPromptError'`）：捕获后停止所有 UI、走正常清理、退出码 130，不打印堆栈。
- 提问前必须停止 spinner，避免光标与重绘冲突；提问结果写入日志（不含敏感值）。
- `@inquirer/prompts` v8 是 ESM，要求 Node `>=20.17`，低于项目基线，无需额外处理。

具体交互点：

| 触发 | 问题 | 默认 |
| --- | --- | --- |
| 账号下有多个 Zone 且未配置 | 选择 Zone | 无默认，必须选择 |
| 无 Token 且未指定 quick | 是否使用临时域名（quick） | 否 |
| 端口被占用 | 复用 / 换端口 / 退出 | 复用 |
| monorepo 多候选 | 选择子包 | 唯一候选时跳过 |
| 同名记录非本工具创建 | 覆盖 / 换随机后缀 / 退出 | 换后缀 |
| `--keep` | 二次确认 | 否 |

## 交互快捷键

运行中（P1，可关闭）：

| 键 | 行为 |
| --- | --- |
| `c` | 复制链接 |
| `o` | 打开浏览器 |
| `q` | 退出并清理（等价 Ctrl+C 的成功路径） |

快捷键只在人类模式、TTY、且没有 prompt 激活时监听；退出时恢复 raw mode 与光标。

## 自动停止（autoStopAfter）

- 配置 `autoStopAfter: '2h'` 或 `--auto-stop 2h` 后，在进入 `running` 时启动计时器，并把 `expiresAt` 写入状态文件。
- 到点：`⚠ 已到达 autoStopAfter（2h），正在停止并清理`，随后走正常清理流程，退出码 `0`。
- 输出面板展示剩余时间与绝对时间（`4h 后自动停止（20:52）`）。
- 被信号中断时清除计时器；重启后若状态文件里的 `expiresAt` 已过期且进程已死，扫描阶段按普通孤儿处理。
- 最小粒度 1s，便于测试；小于 1 分钟时额外提示「仅用于调试」。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 正常结束/主动 `q`/autoStopAfter 到期，且清理成功 |
| `1` | 未分类错误 |
| `2` | 用法/配置错误 |
| `3` | 本地服务失败 |
| `4` | 认证/权限失败 |
| `5` | 隧道创建/启动失败 |
| `6` | 域名/DNS 失败 |
| `7` | 公网验证失败 |
| `8` | 清理未完成（部分资源残留） |
| `130` | 被 SIGINT 中断（清理已尝试执行） |
| `143` | 被 SIGTERM 中断 |

约定：清理失败优先于业务成功——拿到 URL 并运行过，但退出时清理失败，退出码为 `8`。

## doctor

逐项检查并输出（`✔ / ✖ / !`）：

| 检查 | 失败提示 |
| --- | --- |
| Node ≥ 22.14（`styleText` 稳定） | 升级 Node |
| `flash-tunnel.ts` 可加载 | 语法/解析错误 |
| `cloudflared --version` | 安装命令 |
| `CLOUDFLARE_API_TOKEN` 存在 | 权限清单与控制台链接 |
| Token 有效性（`/user/tokens/verify`） | 过期/无效 |
| 账号可见性（`/accounts`） | 多账号时提示配置 `accountId` |
| Zone 存在且 Active | 列出候选 |
| 同名记录冲突（按模板试算） | 建议换模板 |
| 端口可用性 | 占用进程提示 |
| 框架坑（Vite `allowedHosts`/HMR、Next `allowedDevOrigins`） | 给出配置片段 |
| 终端能力 | 无颜色/无 Unicode 时说明降级行为（不算失败） |
| 遗留会话 | 列出可清理项 |

`--json` 输出 `{ checks: [{ id, level, message, hint }] }`。

## 错误输出规范

```text
✖ <一句话说明> [CODE]
  原因  <技术原因，含供应商 message>
  处理  1) <首选修复>  2) <备选修复>
  文档  <相对路径或 URL>
```

- 不打印堆栈，除非 `--verbose` 或 `FLASH_TUNNEL_DEBUG=1`。
- 不回显 Token、Authorization、cloudflared token。
- 用户可操作的错误必须给出下一步命令。
- 网络错误附带「检查出站 7844/UDP 或使用 `--protocol http2`」类提示。
- 错误块用 `theme.err` 渲染符号与标题，`原因/处理/文档` 标签用 dim，内容不加亮。

## 脚本与 CI 集成

```json
{
  "scripts": {
    "preview:share": "flash-tunnel --json --ready-file \"$TMPDIR/flash-tunnel-ready.json\" --auto-stop 2h"
  }
}
```

```yaml
- name: Temporary preview
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: |
    npx flash-tunnel --zone example.com --json --ready-file ready.json &
    PID=$!
    for i in $(seq 1 60); do test -f ready.json && break; sleep 2; done
    URL=$(node -p "require('./ready.json').url")
    echo "preview: $URL"
    kill -INT $PID
    wait $PID
```

CI 提示：`--yes` + `--json` 关闭交互与动画；务必 `wait` 并检查退出码，确保清理完成。
