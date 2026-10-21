# flash-tunnel

在本地项目里执行 `npx flash-tunnel`，自动识别项目、拉起本地服务，并通过可插拔的 DNS / 隧道适配器把服务暴露到一个临时公网地址；退出时自动清理 DNS 记录与隧道。

> 当前版本：`0.0.0`（开发中）。正式版本 `0.1.0` 将在 CI 与 npm Trusted Publisher 配置完成后发布。

## 快速开始

```bash
# 临时 trycloudflare.com 域名，无需 Token
npx flash-tunnel --mode quick

# 自有域名（需要 CLOUDFLARE_API_TOKEN）
export CLOUDFLARE_API_TOKEN=...
npx flash-tunnel --zone example.com
```

第一次使用可以生成配置并检查环境：

```bash
npx flash-tunnel init
npx flash-tunnel doctor
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `flash-tunnel` / `flash-tunnel start` | 默认命令：探测项目、启动本地服务、创建隧道并等待退出 |
| `flash-tunnel clean` | 清理遗留会话（`--session` / `--project` / `--stale` / `--all --yes` / `--dry-run`） |
| `flash-tunnel doctor` | 检查 Node、配置、Token、Zone、cloudflared、端口与遗留会话 |
| `flash-tunnel init` | 生成 `flash-tunnel.ts` 并把 `.flash-tunnel/` 加入 `.gitignore` |
| `flash-tunnel providers` | 列出内置适配器与能力 |
| `flash-tunnel __reap --session <id>` | 内部命令：独立进程兜底清理 |

## 配置

```ts
// flash-tunnel.ts
import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  domain: { zone: 'example.com', subdomain: '{project}-{rand}' },
  server: { command: 'pnpm dev', port: 5173, timeout: 90_000 },
  tunnel: { mode: 'named' },
  autoStopAfter: '2h'
})
```

配置文件可选；相对路径以配置文件所在目录为基准。优先级：CLI > 环境变量 > `flash-tunnel.ts` > 自动探测。

### 常用参数

```text
--cwd <dir>           项目目录
--config <path>       指定 flash-tunnel.ts
--port <n>            期望端口
--command <cmd>       显式启动命令
--url <url>           复用已有服务
--attach              只复用（需要 --url）
--static [dir]        静态托管
--dev                 强制 dev 脚本
--build               启动前执行 build
--reuse               端口被占用时复用
--mode named|quick    隧道模式
--zone / --hostname / --subdomain
--overwrite           覆盖非本工具创建的 DNS 记录
--allow-multilevel    允许多级子域
--auto-stop <dur>     到期自动停止并清理，如 30m / 2h
--keep                退出时保留 DNS 与隧道
--dry-run             只输出生效配置与来源
--json                stdout 输出 NDJSON
--ready-file <path>   把就绪信息写入文件
--on-ready <cmd>      就绪后执行命令，注入 FLASH_TUNNEL_URL 等环境变量
--open / --no-spinner / --no-color / --silent / --yes
```

## 清理与恢复

- 正常退出、`Ctrl+C`、`SIGTERM`、未捕获异常都会尝试停止进程并按顺序删除 DNS 与隧道。
- 强杀或断电后，下次启动会扫描 `~/.flash-tunnel/sessions/`，同项目的过期会话自动回收，其它项目只提示。
- `--keep` 会保留 DNS 与隧道并打印手动清理命令。
- 清理失败保留状态文件并以退出码 `8` 结束，可重复执行 `flash-tunnel clean`。
- 状态文件权限为 `0600`、目录为 `0700`；Token 只从环境变量读取，不落盘。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（唯一凭据来源） |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` | 账号与 Zone id |
| `FLASH_TUNNEL_ZONE` / `FLASH_TUNNEL_HOSTNAME` | 主域名 / 完整主机名 |
| `FLASH_TUNNEL_MODE` / `FLASH_TUNNEL_PORT` / `FLASH_TUNNEL_COMMAND` | 覆盖配置 |
| `FLASH_TUNNEL_CLOUDFLARED` | cloudflared 路径 |
| `FLASH_TUNNEL_AUTO_STOP` | 自动停止时长 |
| `FLASH_TUNNEL_NO_OPEN` | 即使传了 `--open` 也不打开浏览器 |
| `NO_COLOR` / `FORCE_COLOR` / `CI` | 颜色与交互降级 |

## 设计文档

完整设计见 [ai-docs/design-docs/README.md](./ai-docs/design-docs/README.md)。

## 开发

```bash
pnpm install
pnpm build
pnpm ft --version

pnpm lint
pnpm typecheck
pnpm test
```

要求 Node `>=22.14`、pnpm `12.12.1`。

## License

MIT
