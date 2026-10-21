# flash-tunnel 设计文档

`flash-tunnel` 是一个本地 CLI：在项目里执行 `npx flash-tunnel`，它会自动识别项目并拉起本地服务，通过可插拔的「域名适配器 + 隧道适配器」把服务暴露到一个临时公网地址；脚本退出（含 Ctrl+C、异常、崩溃恢复）时自动删除本次创建的 DNS 记录与隧道资源。

首期只对接 Cloudflare（Cloudflare Tunnel + Cloudflare DNS），架构上允许 DNS 与隧道来自不同供应商。

> 当前状态：设计阶段，仓库内只有 `ai-docs/design-docs`，尚无实现代码。
>
> 版本策略：所有可发布包从 `0.0.0` 起步；`flash-tunnel@0.0.0` 是已发布的占位包，其余六个 `@flash-tunnel/*` 用 `bootstrap` 标签占位；`0.1.0` 在 CI 全绿且 npm Trusted Publisher 配置完成后通过 tag 发布。

## 预期使用形态

```bash
cd my-vite-app
npx flash-tunnel
```

也可以安装后只取配置类型：

```bash
pnpm add -D flash-tunnel
```

```ts
// flash-tunnel.ts
import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  domain: { zone: 'example.com' },
})
```

```text
flash-tunnel v0.0.0
◇ 项目      my-vite-app · vite · pnpm
◇ 本地服务  pnpm dev → http://localhost:5173 (1.2s)
◇ 隧道      cloudflare/named · flash-tunnel-my-vite-app-k3f9
◇ 域名      https://my-vite-app-k3f9.example.com (CNAME → k3f9…cfargotunnel.com, proxied)
◇ 验证      200 OK (2.4s)
────────────────────────────────────────────────
  Preview  https://my-vite-app-k3f9.example.com
  按 Ctrl+C 退出，自动删除 DNS 记录与隧道
```

## 设计要点

1. **零配置优先**：配置文件 `flash-tunnel.ts` 可省略；省略时靠项目探测、环境变量与唯一候选推断工作，每个配置项都有可解释的默认值。配置只认 `.ts` 后缀，用 `unconfig` 加载。
2. **适配器拆分**：`DnsAdapter`（域名/记录）与 `TunnelAdapter`（隧道/进程/公网入口）是两个独立契约，可自由组合；适配器通过 npm 包或本地路径加载。
3. **资源账本**：所有外部副作用（子进程、隧道、DNS 记录）都登记在账本里，按 LIFO 回滚；正常退出、信号、崩溃、下次启动扫描四层兜底。
4. **只删自己创建的东西**：DNS 记录带 `comment` 标记、隧道名带前缀、状态文件记录 id；清理前先校验归属，永不按域名模式批量删除。
5. **终端体验是一等公民**：`node:util` 的 `styleText` 负责颜色（零依赖）、`yocto-spinner` 负责步骤动画（关闭信号接管，保证 `Ctrl+C` 能清理）、`@inquirer/prompts` 负责选择；非 TTY/CI 自动降级为逐行输出。
6. **工程化与现有 monorepo 对齐**：pnpm workspace + catalog 可选、ESLint（antfu 规则、无尾逗号）、simple-git-hooks + nano-staged、unbuild + stub、vitest、bumpp 发布。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-product.md](./01-product.md) | 背景、场景、目标/非目标、验收标准、与现有工具的差异 |
| [02-architecture.md](./02-architecture.md) | 分层与包结构、主流程时序、状态机、资源模型、事件、依赖规则 |
| [03-adapter-contracts.md](./03-adapter-contracts.md) | DNS/隧道适配器接口、能力矩阵、组合校验、加载与第三方适配器规范 |
| [04-cloudflare.md](./04-cloudflare.md) | Cloudflare 对接细节：鉴权、Tunnel API、ingress、DNS、cloudflared、验证、清理、错误码与坑 |
| [05-local-server.md](./05-local-server.md) | 项目识别、包管理器、框架端口、启动/复用、就绪探测、日志与跨平台停止 |
| [06-configuration.md](./06-configuration.md) | `flash-tunnel.ts` 类型、默认值、模板变量、环境变量、优先级、npx 兼容 |
| [07-cli.md](./07-cli.md) | 命令、参数、终端输出（`styleText`/spinner/prompts）、JSON/CI 模式、退出码、doctor |
| [08-lifecycle-cleanup.md](./08-lifecycle-cleanup.md) | 资源账本、回滚、信号与崩溃矩阵、reaper、孤儿扫描、状态文件格式 |
| [09-security.md](./09-security.md) | 威胁模型、最小权限 Token、凭据处理、误删保护、供应链 |
| [10-testing.md](./10-testing.md) | 单测、适配器一致性测试、HTTP mock、进程测试、真实账号 E2E |
| [11-engineering.md](./11-engineering.md) | monorepo 目录与全部基础配置（ESLint/hooks/build/test/CI/发布） |
| [12-roadmap.md](./12-roadmap.md) | 里程碑、验收、需先验证的技术假设、后续扩展 |
| [checklist.md](./checklist.md) | 实施核对清单（按模块勾选） |

## 术语

| 术语 | 含义 |
| --- | --- |
| **会话（session）** | 一次 `flash-tunnel` 运行；id 形如 `ft_m3k9x_7fa2`，贯穿日志、状态文件、DNS comment |
| **资源账本（ledger）** | 本次会话已创建资源的登记表，含归属信息与补偿动作 |
| **本地服务（local server）** | 被暴露的项目进程，可能由本工具启动，也可能是复用的已运行服务 |
| **隧道（tunnel）** | 建立「公网入口 → 本地服务」的通道及其控制面资源 |
| **DNS 记录（record）** | 把公网域名指向隧道入口的记录（Cloudflare 场景是 CNAME + 橙云） |
| **适配器（adapter）** | 实现 `DnsAdapter` 或 `TunnelAdapter` 契约的模块，负责某个供应商的控制面操作 |
| **自动停止（autoStopAfter）** | 可选的会话时限，到期自动清理；默认关闭 |
| **reaper** | 在进程已退出/崩溃后，由独立子进程执行的清理兜底逻辑 |

## 阅读顺序建议

- 只想了解产品：01 → 07
- 要开始写代码：02 → 03 → 04 → 08 → 11 → checklist
- 要新增供应商适配器：03 → 04（作为参考实现）→ 10
