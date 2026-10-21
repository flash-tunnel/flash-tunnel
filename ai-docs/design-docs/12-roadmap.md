# 12 · 里程碑与实施计划

## 实施原则

1. **先打通真实链路，再抽象**：M1 用真实 Cloudflare 账号验证 API 行为，确认后再固化适配器契约。
2. **清理与创建同批交付**：每个能创建资源的里程碑，必须同时交付对应的删除路径与测试，不留「后面再补清理」。
3. **每一步可演示**：每个里程碑结束都有可执行的 `flash-tunnel` 行为，而不是只有库代码。

## 需要先验证的技术假设（M0 期间）

| # | 假设 | 验证方式 | 失败时的备选 |
| --- | --- | --- | --- |
| S1 | `POST /cfd_tunnel` 带 `config_src: cloudflare` 返回可用 `token` | 真实账号调用一次，记录响应 | 调 `GET /cfd_tunnel/{id}/token`；再不行退回本地 `cert.pem` 模式（需 `cloudflared tunnel login`） |
| S2 | 通过 API 写入的 ingress 对 `cloudflared tunnel run` 立即生效 | 起一个本地服务，curl 公网域名 | 改用本地配置文件模式（`config.yml` + `tunnel run`） |
| S3 | 停止 cloudflared 后连接数在数秒内归零 | 观察 `GET /cfd_tunnel/{id}` 的 connections | 调用 `DELETE .../connections` 强制清理 |
| S4 | 隧道有活跃连接时 `DELETE` 会失败 | 故意在连接中删除 | 清理连接后重试；超时后标记 dangling |
| S5 | Windows 上能可靠停止 `pnpm dev` 的进程树 | 起一个会 spawn 子进程的脚本，`taskkill /T /F` | 使用 `tree-kill` 或 Job Object 封装 |
| S6 | `npx` 场景下 unconfig 能加载项目的 `flash-tunnel.ts`，且 `defineConfig` shim 生效 | 在临时目录用 `npm pack` + `npx ./pkg.tgz` 验证 | 用户配置改为纯对象导出（不 import 包） |
| S7 | Vite/Next dev server 对公网 Host 的接受方式 | 实测 403 场景与 `allowedHosts`/`httpHostHeader` | 在 `doctor` 中强提示，必要时自动注入 Host 头 |
| S8 | 终端库不会劫持 `SIGINT` | 读源码确认 `nanospinner`/`picospinner` 的 `start()` 会 `process.exit`；`yocto-spinner` 支持 `handleSignals: false` | 已确认，选 `yocto-spinner`；M2 再用集成测试锁定 |

结论记录到 `ai-docs/design-docs/` 下的 `spike-notes.md`（新增文件），并回写本文相关章节。

## M0 · 脚手架与工程化（0.5–1 天）

**交付**

- pnpm workspace、七个包骨架（版本统一 `0.0.0`）、根配置（ESLint/tsconfig/vitest/unbuild/hooks/CI）。
- `.github/workflows/ci.yaml` 与 `release.yaml` 落盘；`release.yaml` 先不触发（等 0.1.0 tag）。
- `packages/types` 的契约与错误类型；`packages/config` 的 `defineConfig` 与配置类型；`packages/cli` 的 `runCli` 骨架；`packages/flash-tunnel` 的 bin 与重导出。
- CLI 输出骨架：`ui/output.ts`（human/json 双通道）、`theme.ts`（`styleText`）、`symbols.ts`、spinner 封装（`handleSignals: false`）。
- `flash-tunnel --version` / `--help` 可运行（`pnpm ft`）。

**验收**

- `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿。
- `node packages/flash-tunnel/bin/flash-tunnel.mjs --version` 输出正确版本。
- pre-commit 能对暂存文件执行 ESLint。

## M1 · 本地服务探测与运行（2–3 天）

**交付**

- `core/server`：包管理器识别、脚本优先级、框架端口表、输出解析、就绪探测、进程树停止、静态模式。
- `--dry-run` 输出探测结果；`--port/--command/--url/--attach/--static` 生效。
- 单元测试 + 真实子进程集成测试（无网络）。

**验收**

- 在 Vite、Next、纯静态目录三类 fixture 上，`flash-tunnel --dry-run` 给出正确命令与端口。
- 端口被占、脚本不存在、启动超时三类错误输出可读且退出码正确。
- 本地服务能被完整停止，无残留进程（Windows + Linux）。

## M2 · Cloudflare 快速链路（2–3 天）

**交付**

- `@flash-tunnel/adapter-cloudflare` 的 `cloudflareTunnel`（quick 模式）。
- `cloudflared` 检测、启动、日志捕获、停止；公网 URL 解析。
- `core` 状态机、账本、事件；CLI 步骤行（spinner 成功/失败/耗时）。
- 颜色与符号的降级策略（`NO_COLOR`、非 TTY、Windows conhost）。

**验收**

- 无 Token 时 `flash-tunnel` 能拿到 `*.trycloudflare.com` 地址并访问。
- 每个阶段都有 spinner 步骤行，失败时先停 spinner 再打印错误块。
- `Ctrl+C` 后进程退出、无残留 cloudflared（spinner 不抢信号）。
- 模拟 cloudflared 异常退出，会话能收敛并给出退出码 5。

## M3 · 自有域名与自动清理（3–5 天）

**交付**

- `cloudflareDns` + named 隧道：preflight、隧道创建、ingress、DNS、健康检查、公网验证。
- 资源账本持久化、正常退出清理、reaper、孤儿扫描、`clean` 命令。
- `autoStopAfter`（`expiresAt` 落盘、到点清理、退出码 0）与 `--keep`。
- 组合校验（能力矩阵）、Token/Zone/冲突错误映射。
- 关键测试：删除顺序、404 幂等、连接未断开重试、kill -9 恢复。

**验收**

- 通过 01 文档的 7 条验收标准。
- 连续 3 次运行无遗留；强杀后下次运行自动回收。
- Token 缺权限时零资源创建。

## M4 · 体验、可扩展性与发布（3–4 天）

**交付**

- `doctor`、`init`、`providers`、`--json`、`--ready-file`、`--on-ready`。
- `@inquirer/prompts` 交互（Zone 选择、端口冲突、monorepo、quick 降级、记录冲突），以及 `ExitPromptError` 的统一处理。
- 二维码/剪贴板/自动打开；非 TTY 降级；`--no-spinner`/`--no-color`。
- 文档：README、配置参考、Cloudflare Token 创建指引、故障排查。
- `@flash-tunnel/testing` 一致性测试套件（可选，若时间允许）。
- 发布：本地 `0.0.0` 占位发布（`--tag bootstrap`）→ CI 全绿 → 配置 Trusted Publisher（2 天内完成首发）→ `bumpp` 到 `0.1.0` → tag 触发 OIDC 发布。

**验收**

- CI 矩阵（Linux/Windows × Node 22/24）通过。
- 七个包在 npm 上存在；六个 `@flash-tunnel/*` 的 `0.0.0` 只挂 `bootstrap`，`flash-tunnel@0.0.0` 的 `latest` 在 0.1.0 发布后被覆盖为 `0.1.0`。
- npm 包设置里 Trusted Publisher 指向 `release.yaml`，发布日志无 Token、有 provenance。
- 干净机器 `npx flash-tunnel@0.1.0` 按 README 步骤可跑通。
- 真实账号 E2E 通过并完成清理。

## 之后（0.2+）

| 方向 | 内容 | 前置 |
| --- | --- | --- |
| frp 适配器 | 用现有 `frp-bridge` 经验实现自建隧道，验证「CF 域名 + frp 隧道」组合 | 契约稳定 |
| 其他 DNS | DNSPod / 阿里云 / Route53 | 同上 |
| Access 保护 | 一键创建 Cloudflare Access Application + OTP/邮箱策略 | Tunnel 适配器稳定 |
| 固定域名池 | 预分配若干子域，写死模板复用，减少 DNS 变更 | 清理逻辑可靠 |
| 团队面板 | 会话登记、到期回收、审计 | 服务端组件 |
| 桌面通知/Webhook | `hooks.onReady` 扩展 | 无 |

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Cloudflare API 行为与文档不一致（S1/S2） | M3 返工 | M0 先做 spike，结论落文档 |
| 清理不可靠导致用户不敢用 | 产品核心失效 | 账本 + reaper + 扫描 + 幂等测试，作为发布门槛 |
| 用户 Token 权限不足/配置错误 | 首次体验差 | `doctor` + 错误提示 + `--dry-run` |
| Windows 进程树/信号差异 | 残留进程 | 独立测试平台分支，早期在 Windows 开发验证 |
| Vite/Next 的 Host 校验 | 公网 403 被误判为失败 | doctor 检测 + 明确错误文案 + ingress Host 头兜底 |
| 子域冲突/DNS 缓存 | 偶发访问异常 | 默认随机后缀；固定子域显式提示风险 |
| 适配器抽象过度 | 拖慢 MVP | 只抽 DNS/隧道两个契约；server/notifier 先内置 |

## 工作量概览

| 里程碑 | 人日（估） | 可演示结果 |
| --- | --- | --- |
| M0 | 1–1.5 | 空壳 CLI + 工程化 + 输出骨架（theme/spinner/output） |
| M1 | 2–3 | 自动起本地服务并打印地址 |
| M2 | 2–3 | 拿到公网临时域名 + 步骤行动画 |
| M3 | 3–5 | 自有域名 + 退出自动清理 |
| M4 | 3–4 | 可发布的 0.1.0 |

合计约 12–17 人日；若只做「Cloudflare named + 清理」的最小闭环，可在 M3 结束时提前内部试用。
