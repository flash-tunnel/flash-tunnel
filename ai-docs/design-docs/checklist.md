# 实施核对清单

按模块勾选；每项完成后在 PR 描述中引用对应文档章节。

## 工程化（M0）

- [x] `pnpm-workspace.yaml`（`shellEmulator`、`packages/*`、`allowBuilds`）
- [x] 根 `package.json`（`version: 0.0.0`、`private: true`、`packageManager: pnpm@12.12.1`、`repository.url`、scripts、hooks、nano-staged）
- [x] 七个包统一 `version: 0.0.0`，各自带与根一致的 `repository`
- [x] `eslint.config.ts`（antfu + `type: 'lib'` + 无尾逗号 + 忽略 ai-docs/dist）
- [x] `tsconfig.json` + 各包 `tsconfig.json`（strict、`noUncheckedIndexedAccess`、Bundler）
- [x] `vitest.config.ts`（node 环境、覆盖率阈值、net connect 禁用）
- [x] `scripts/build.common.ts` + 各包 `build.config.ts`
- [x] 七个包：`flash-tunnel` / `cli` / `config` / `core` / `types` / `utils` / `adapter-cloudflare`
- [x] `packages/flash-tunnel/bin/flash-tunnel.mjs` 可执行位与 shebang
- [x] `.gitignore`（`node_modules`、`dist`、`.flash-tunnel/`、`coverage`、`*.log`）
- [x] `.editorconfig`、`LICENSE`、`README.md` 骨架
- [x] 只有 `.github/workflows/release.yaml`（仅 `v*` tag 触发；verify 矩阵 Linux/Windows × Node 22/24，通过后才 publish）
- [x] 不存在 push/PR 触发的 ci.yaml；需要独立 check 时只能 `workflow_call` 由 release.yaml 调用
- [x] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿

## 契约与类型（03）

- [x] `AdapterError`（code/retriable/hint/details）
- [x] `DnsAdapter`、`DnsCapabilities`、`DnsRecordSpec/Ref`
- [x] `TunnelAdapter`、`TunnelCapabilities`、`TunnelProvisionSpec`、`TunnelHandle/Status/Hooks`
- [x] `ADAPTER_API_VERSION` 与运行时守卫 `isDnsAdapter` / `isTunnelAdapter`
- [x] `@flash-tunnel/config` 导出 `defineConfig`（identity）与配置类型
- [x] `flash-tunnel` 根导出与 `flash-tunnel/config` 子路径都再导出 config
- [x] `@flash-tunnel/cli` 导出 `runCli`，不含 bin
- [x] `defineDnsAdapter` / `defineTunnelAdapter` 类型工具
- [x] `FlashTunnelEvents` 事件类型
- [x] 适配器 id 常量化（`cloudflare`）

## 配置（06）

- [x] 配置面仅 17 字段：`domain` / `server` / `tunnel` / `providers` / `autoStopAfter`
- [x] unconfig 加载 `flash-tunnel.ts`（extensions 仅 `ts`、`merge: false`）
- [x] 向上查找到 git 根；`--config` 直接加载；相对路径以配置文件目录为基准
- [x] `defineConfig` shim（transform 重写 import）
- [x] 默认值推导：zone/local server/port/account/mode，失败路径可操作
- [x] 模板渲染（`{project}`/`{branch}`/`{rand:N}`/`{session}`/`{ts}`）
- [x] 主机名校验（长度、字符、多级子域、通配符）
- [x] 环境变量映射（`CLOUDFLARE_*`、`FLASH_TUNNEL_*`）
- [x] 优先级：CLI > env > config > 探测
- [x] 校验错误路径化输出；未知字段警告
- [x] `--dry-run` 输出生效配置 + 来源（`default/detected/env/config/inferred`）
- [x] 不提供 Token/清理/UI/hook 配置项（代码里也没有这些字段）

## 本地服务（05）

- [x] 由 `command` / `url` / `dir` 推断模式，无 `server.type`
- [x] 包管理器识别（`packageManager` / 锁文件）
- [x] 脚本优先级（preview → dev → start）
- [x] preview 产物缺失：自动降级 dev；无 dev 时提示 `--build`
- [x] 框架端口表与脚本参数端口解析
- [x] stdout 解析（ANSI 剥离、`Local:` 优先、IPv6）
- [x] 就绪探测（TCP + HTTP，任意状态码，超时 `server.timeout`）
- [x] 端口冲突处理（TTY 询问 / 非 TTY 失败 / `--reuse`）
- [x] monorepo 子包候选与 `server.cwd`
- [x] 静态模式（MIME、SPA 回退、路径穿越防护、默认 4173）
- [x] 进程组启动与跨平台停止（SIGTERM → SIGKILL / `taskkill /T /F`）
- [x] 日志文件与最近 10 个会话清理
- [x] 子进程提前退出、启动超时的错误输出

## Cloudflare 适配器（04）

- [x] API 客户端（Bearer、包络解析、超时、重试、脱敏、`apiBase`）
- [x] `preflight`：Token 验证、账号解析、Zone 校验、记录冲突、cloudflared 检测
- [x] 创建隧道（`config_src: cloudflare`）、token 兜底接口
- [x] ingress 写入（catch-all、`originRequest.noTLSVerify`、`httpHostHeader`）
- [x] DNS 记录创建（CNAME、proxied、ttl 1、comment 标记）
- [x] 冲突处理：本工具标记自动回收，非本工具需 `--overwrite`
- [x] cloudflared 启动（`TUNNEL_TOKEN` 环境变量、`--no-autoupdate`、日志捕获）
- [x] `waitReady`：API healthy + connections > 0（超时 30s）
- [x] 公网验证：HTTPS 探测接受 2xx–4xx、超时 60s、DoH 诊断
- [x] 停止：SIGTERM → 5s → kill tree
- [x] 删除：DNS → 连接清理 → 隧道；404 幂等
- [x] quick 模式（URL 解析、无 DNS、进程清理）
- [x] 错误码映射表与用户提示
- [x] cloudflared 版本检查与安装提示

## 编排与状态（02/08）

- [x] 状态机与非法转换保护
- [ ] 资源账本（kind/provider/ref/origin/owned/dispose）
- [x] 逆序回滚、单步失败不阻断、超时预算
- [x] 会话 id、项目锁、心跳（15s）
- [x] 状态文件原子写（tmp + rename）、权限 0600
- [x] 全局 `~/.flash-tunnel/sessions` 索引
- [x] 事件总线（NDJSON 兼容）
- [x] 组合校验 C1–C7
- [x] 适配器注册表与动态加载（内置/npm/本地 ts）
- [x] 第三方适配器 `apiVersion` 校验与错误提示
- [x] `autoStopAfter`：`expiresAt` 落盘、到点正常清理、退出码 0

## 清理与恢复（08）

- [x] 正常退出清理（含超时预算与失败汇总）
- [x] 信号处理：SIGINT/SIGTERM/SIGHUP，清理后按约定退出码
- [x] spinner 以 `handleSignals: false` 创建，信号所有权归 core/CLI
- [x] `uncaughtException` / `unhandledRejection` 触发清理
- [x] 本地服务/隧道异常退出触发会话收敛
- [x] `process.on('exit')` 同步兜底 `spawnSync(__reap)`
- [x] `__reap` 命令（pid 校验、API 清理、日志、失败保留状态）
- [x] 启动孤儿扫描（同项目自动、跨项目提示、心跳判断）
- [x] `clean`（`--session/--project/--all/--stale/--dry-run/--yes`）
- [x] 归属校验（comment + id 双重）
- [x] `--keep`：保留 DNS/隧道、标记 kept、输出手动清理命令
- [x] 清理幂等双跑测试
- [x] 清理失败退出码 8 与可重试状态

## CLI 与 UX（07）

- [x] `cac` 命令注册（默认 start、clean、doctor、init、providers、`__reap`）
- [x] 全部参数与互斥校验（含 `--keep`/`--overwrite`/`--allow-multilevel`/`--reuse`）
- [x] `node:util` `styleText` 主题（16 色 + 修饰，`{ stream }` 正确）
- [x] 颜色尊重 `NO_COLOR`/`FORCE_COLOR`/`NODE_DISABLE_COLORS`/TTY
- [x] 符号与颜色双通道表意；Unicode 降级（Windows conhost）
- [x] `yocto-spinner` 步骤行（`handleSignals: false`、非 TTY 不启动、verbose 关闭）
- [x] step runner：成功/失败/耗时/phase 分组；失败先停 spinner
- [x] `@inquirer/prompts`（Zone/端口冲突/monorepo/quick 降级/记录冲突）
- [x] `ExitPromptError` → 清理 + 退出码 130，无堆栈
- [x] 非 TTY/CI：逐行输出、无 ANSI、无交互
- [x] `--json`（stdout 仅 NDJSON、stderr 人类日志、错误事件）
- [x] `--ready-file` / `--on-ready` / `--silent` / `--no-open` / `--no-spinner` / `--no-color`
- [x] 快捷键（c/o/q，可关闭；退出恢复 raw mode 与光标）
- [x] 退出码 0/1/2/3/4/5/6/7/8/130/143
- [x] `doctor` 检查项与 `--json`
- [x] `init` 生成配置 + `.gitignore`
- [x] 错误输出规范（原因/处理/文档，无堆栈）

## 安全（09）

- [x] Token 只从环境变量读取，不落盘、不进配置文件字段
- [x] 日志脱敏（Bearer/JWT/token=）
- [x] cloudflared token 走 env，不进 argv
- [x] 随机子域默认；固定名/多级子域/`--overwrite`/`--keep` 警告
- [x] 删除只按 id + comment 校验
- [x] 状态/日志权限（0700/0600）
- [ ] 自动下载默认关闭；开启时校验 sha256
- [x] 配置中无凭据字段（类型层面就不存在）

## 测试（10）

- [x] 配置加载/模板/校验/来源标注单测
- [x] 新配置面外没有遗留字段（编译期即可发现）
- [x] 探测 fixture 单测（含 monorepo、锁文件、输出解析、preview 降级）
- [ ] 账本/回滚/超时/幂等单测
- [x] 状态文件原子写与损坏恢复
- [x] Cloudflare 适配器 MockAgent 用例（鉴权、冲突、token 兜底、429、404、连接清理）
- [x] 适配器一致性套件（若交付 `@flash-tunnel/testing`）
- [x] UI 单测：`NO_COLOR`/`FORCE_COLOR` 下的输出、非 TTY 无动画、`--json` 纯净 stdout
- [x] prompts 取消（`ExitPromptError`）路径测试
- [x] 集成测试（fake 适配器 + 真实子进程信号）
- [x] Windows 进程树停止测试
- [ ] E2E（gated）创建 → 验证 → 清理 → 断言无残留
- [x] kill -9 恢复测试
- [ ] release verify 矩阵通过（tag 触发）

## 发布

- [x] README（安装、Token 配置、示例、FAQ、故障排查）
- [x] 文档站/README 链接到本设计文档
- [x] `npm pack --dry-run` 检查 `bin`/`dist`/`exports`
- [x] 本地占位发布：`flash-tunnel@0.0.0` 已存在，只需 `pnpm --filter "@flash-tunnel/*" -r publish --access public --tag bootstrap`
- [x] 删除预发布版本 `0.0.0-stage`（72h 内）：`npm unpublish flash-tunnel@0.0.0-stage`
- [x] 保留 `flash-tunnel@0.0.0` 现状（`latest` 不动，不加 deprecate），等 0.1.0 覆盖
- [x] npm 上七个包均存在，`repository` 与 GitHub 仓库完全一致
- [x] 本地 lint/typecheck/test/build 通过（tag 前的唯一门禁）
- [x] 七个包分别配置 Trusted Publisher（GitHub Actions / `flash-tunnel/flash-tunnel` / `release.yaml` / 允许 `npm publish`）
- [x] 记住 2 天验证窗口：配置后当天发 `0.1.0`
- [x] `pnpm release` 将七个包从 `0.0.0` 升到 `0.1.0`，push `v0.1.0` tag
- [x] `release.yaml` 通过 OIDC 发布成功，无 Token、有 provenance
- [x] npm `latest` 指向 `0.1.0`（覆盖 `flash-tunnel@0.0.0` 的占位 latest）
- [x] 干净环境 `npx flash-tunnel@0.1.0` 冒烟
- [x] 可选：npm 包设置改为「Require 2FA and disallow tokens」
