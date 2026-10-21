# flash-tunnel

**一条命令，把本地服务变成可分享的公网预览。**  
自动探测并启动本地服务，通过 Cloudflare Tunnel 暴露到公网；退出时自动清理 DNS 记录、隧道和子进程。

[English](https://github.com/flash-tunnel/flash-tunnel/blob/main/README.md) | **简体中文**

[![npm version](https://img.shields.io/npm/v/flash-tunnel?style=flat-square&color=blue)](https://www.npmjs.com/package/flash-tunnel)
[![npm downloads](https://img.shields.io/npm/dm/flash-tunnel?style=flat-square)](https://www.npmjs.com/package/flash-tunnel)
[![license](https://img.shields.io/npm/l/flash-tunnel?style=flat-square)](https://github.com/flash-tunnel/flash-tunnel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/flash-tunnel?style=flat-square)](https://www.npmjs.com/package/flash-tunnel)

> 当前为早期预览版（`0.0.x`），接口和行为仍可能调整。

## 为什么用它

- **零配置开始**：`--mode quick` 不需要 Token，直接拿到 `*.trycloudflare.com` 临时地址。
- **自有域名**：一条命令创建 Cloudflare Tunnel、写 DNS、启动 cloudflared 并验证公网访问。
- **退出即清理**：正常退出、`Ctrl+C`、`SIGTERM` 都会按顺序清理资源；异常退出还有兜底扫描。
- **自动识别项目**：支持 Vite、Next、Nuxt、Astro、SvelteKit、静态目录等常见项目。
- **适合 CI**：`--json`、`--ready-file`、`--on-ready`、`--auto-stop` 可组合出无人值守预览。

## 工作流程

1. 识别项目框架、包管理器、启动脚本和端口。
2. 启动本地服务，或复用已有服务。
3. 创建 Cloudflare Tunnel、写 DNS 记录并启动 cloudflared。
4. 等待公网 URL 可访问，然后打印地址。
5. 退出时清理隧道、DNS 记录和子进程。

## 环境要求

- Node.js **>= 22.14**
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- Cloudflare 账号（仅 named 模式需要）

```bash
cloudflared --version
```

## 快速开始

### 临时域名（无需 Token）

```bash
npx flash-tunnel --mode quick
```

### 自有域名（需要 Token）

```bash
# macOS / Linux
export CLOUDFLARE_API_TOKEN=your_token_here

# Windows PowerShell
$env:CLOUDFLARE_API_TOKEN = "your_token_here"

npx flash-tunnel --zone example.com
```

第一次使用建议先跑体检和配置生成：

```bash
npx flash-tunnel doctor
npx flash-tunnel init
```

## 安装

```bash
# 直接运行，无需安装
npx flash-tunnel

# 全局安装
npm install -g flash-tunnel

# 作为项目开发依赖（推荐，便于固定版本）
pnpm add -D flash-tunnel
```

安装后可以运行：

```bash
flash-tunnel --version
flash-tunnel doctor
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `flash-tunnel` / `flash-tunnel start` | 探测项目、启动本地服务、创建隧道并等待退出 |
| `flash-tunnel clean` | 清理遗留会话：`--session` / `--project` / `--stale` / `--all --yes` / `--dry-run` |
| `flash-tunnel doctor` | 检查 Node、配置、Token、Zone、cloudflared、端口和遗留会话 |
| `flash-tunnel init` | 生成 `flash-tunnel.ts`，并把 `.flash-tunnel/` 加进 `.gitignore` |
| `flash-tunnel providers` | 列出内置适配器与能力矩阵 |

## 配置

配置文件是可选的。放在项目根目录（或任意上级目录到 git 根）即可：

```ts
// flash-tunnel.ts
import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  domain: {
    zone: 'example.com',
    subdomain: '{project}-{rand}'
  },
  server: {
    command: 'pnpm dev',
    port: 5173,
    timeout: 90_000
  },
  tunnel: {
    mode: 'named'
  },
  autoStopAfter: '2h'
})
```

- 相对路径以**配置文件所在目录**为基准。
- 配置优先级：**CLI > 环境变量 > `flash-tunnel.ts` > 自动探测**。
- `subdomain` 支持模板：`{project}`、`{branch}`、`{rand}`、`{rand:6}`、`{session}`、`{ts}`。
- 完整字段和默认值见[配置设计](https://github.com/flash-tunnel/flash-tunnel/blob/main/ai-docs/design-docs/06-configuration.md)。

### 常用参数

**本地服务**

| 参数 | 说明 |
| --- | --- |
| `--cwd <dir>` | 项目目录 |
| `--config <path>` | 指定 `flash-tunnel.ts` |
| `--port <n>` | 期望端口 |
| `--command <cmd>` | 显式启动命令 |
| `--url <url>` | 复用已运行的服务 |
| `--attach` | 只复用，不启动（需要 `--url`） |
| `--static [dir]` | 静态目录托管 |
| `--dev` | 强制使用 dev 脚本 |
| `--build` | 启动前执行 build |
| `--reuse` | 端口被占用时复用已有服务 |

**隧道与域名**

| 参数 | 说明 |
| --- | --- |
| `--mode named\|quick` | 隧道模式 |
| `--zone <domain>` | Cloudflare 主域名 |
| `--hostname <fqdn>` | 完整公网主机名 |
| `--subdomain <label>` | 子域模板或字面量 |
| `--allow-multilevel` | 允许多级子域（需要 Advanced Certificate） |
| `--overwrite` | 覆盖非本工具创建的 DNS 记录（危险） |
| `--auto-stop <dur>` | 到期自动停止并清理，如 `30m`、`2h` |
| `--keep` | 退出时保留 DNS 记录与隧道 |

**输出与自动化**

| 参数 | 说明 |
| --- | --- |
| `--dry-run` | 只打印生效配置和来源，不创建资源 |
| `--json` | stdout 输出 NDJSON，人类日志走 stderr |
| `--silent` | 只输出错误 |
| `--ready-file <path>` | 就绪后写入 JSON 文件 |
| `--on-ready <cmd>` | 就绪后执行命令，注入环境变量 |
| `--open` | 就绪后打开浏览器 |
| `--verbose` | 透传 dev server / cloudflared 日志 |
| `--no-color` / `--no-spinner` / `-y, --yes` | 关闭颜色 / 动画 / 交互 |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（唯一凭据来源） |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID；只有一个账号时可省略 |
| `CLOUDFLARE_ZONE_ID` | Zone ID；通常可省略，工具会用域名查询 |
| `FLASH_TUNNEL_ZONE` | 主域名，等价于 `domain.zone` |
| `FLASH_TUNNEL_HOSTNAME` | 完整主机名，优先级高于 zone/subdomain |
| `FLASH_TUNNEL_MODE` | `named` 或 `quick` |
| `FLASH_TUNNEL_PORT` | 期望端口 |
| `FLASH_TUNNEL_COMMAND` | 启动命令 |
| `FLASH_TUNNEL_CLOUDFLARED` | cloudflared 可执行文件路径 |
| `FLASH_TUNNEL_AUTO_STOP` | 自动停止时长 |
| `FLASH_TUNNEL_NO_OPEN` | 即使传了 `--open` 也不打开浏览器 |
| `NO_COLOR` / `FORCE_COLOR` / `CI` | 颜色、动画和交互降级 |

### Cloudflare Token 权限

在 <https://dash.cloudflare.com/profile/api-tokens> 创建 **Custom token**，添加：

| 权限 | 用途 |
| --- | --- |
| Account · Cloudflare Tunnel · Edit | 创建/删除隧道、写 ingress、清理连接 |
| Zone · DNS · Edit | 创建/删除 CNAME、检查冲突 |
| Zone · Zone · Read | 列出 Zone，自动推断主域名 |
| Account · Account Settings · Read | 列出账号，自动推断 Account ID |

> 新版 Cloudflare 后台可能把 `Edit` 显示为 `Write`，含义相同。

## 清理与恢复

正常退出时会：

1. 停止 cloudflared
2. 等待连接排空
3. 删除 DNS 记录
4. 删除隧道
5. 停止本地服务
6. 删除会话状态和项目锁

其他情况：

- `Ctrl+C` / `SIGTERM` / `SIGHUP`：按正常流程清理，退出码 `130` / `143`。
- 第二次 `Ctrl+C`：立即退出，保留状态文件，交给后台 watchdog 或下次启动回收。
- 强杀 / 终端被关闭：独立 watchdog 会在主进程消失后尝试清理；下次启动也会扫描 `~/.flash-tunnel/sessions/`。
- `--keep`：保留 DNS 与隧道，退出时会打印手动清理命令。
- 清理失败：退出码 `8`，状态文件保留，可重复执行 `flash-tunnel clean`。

```bash
# 查看遗留会话
flash-tunnel clean

# 清理本项目的过期会话
flash-tunnel clean --stale

# 清理指定会话
flash-tunnel clean --session ft_xxxx

# 清理所有会话（需要确认）
flash-tunnel clean --all --yes
```

## CI 集成

```bash
npx flash-tunnel \
  --json \
  --ready-file .flash-tunnel/ready.json \
  --auto-stop 2h
```

- stdout 只有 NDJSON；`ready` 事件里包含公网 URL。
- `--ready-file` 适合在脚本里轮询。
- `--on-ready` 会注入 `FLASH_TUNNEL_URL`、`FLASH_TUNNEL_LOCAL_URL`、`FLASH_TUNNEL_SESSION_ID` 等变量。

```bash
# 读取 ready 文件里的 URL
node -p "require('./.flash-tunnel/ready.json').url"
```

## 安全

- Token 只从环境变量读取，不写入配置、不落盘、不出现在命令行参数里。
- 建议 Token 只授予上表四项权限，并设置过期时间。
- 默认随机子域，减少冲突和缓存问题。
- 删除 DNS/隧道前会校验会话记录的 id 与归属标记。
- 状态目录权限 `0700`，状态文件 `0600`。
- `--overwrite` 会替换非本工具创建的 DNS 记录，仅在确认无误时使用。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `Cannot run cloudflared` | 安装 cloudflared，或设置 `FLASH_TUNNEL_CLOUDFLARED` |
| `AUTH_INVALID` / `403` | Token 缺少 Tunnel/DNS/Zone 权限 |
| `ACCOUNT_NOT_FOUND` | 设置 `CLOUDFLARE_ACCOUNT_ID` |
| `ZONE_NOT_FOUND` / `ZONE_NOT_ACTIVE` | 检查 `--zone`，确认域名已在 Cloudflare 激活 |
| `RECORD_CONFLICT` | 换一个 `--subdomain`，或确认后使用 `--overwrite` |
| `No runnable script found` | 配 `server.command`，或用 `--static dist` / `--cwd` |
| 端口被占用 | 用 `--port <n>` 或 `--reuse` |
| 终端快捷键无响应 | 点击终端窗口后重试；会话 ID 会打印在启动信息里 |
| 清理退出码 `8` | 重复执行 `flash-tunnel clean --stale` |

## 开发

```bash
pnpm install
pnpm build
pnpm ft --version

pnpm lint
pnpm typecheck
pnpm test
```

要求 Node `>= 22.14`、pnpm `12.12.1`。

端到端测试默认跳过，需要真实 Cloudflare 账号：

```bash
FLASH_TUNNEL_E2E=1 pnpm test:e2e
```

## 设计文档

完整设计见 [ai-docs/design-docs](https://github.com/flash-tunnel/flash-tunnel/tree/main/ai-docs/design-docs)（中文）。

## License

[MIT](https://github.com/flash-tunnel/flash-tunnel/blob/main/LICENSE)
