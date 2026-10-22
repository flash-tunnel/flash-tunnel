# 09 · 安全设计

## 威胁模型

`flash-tunnel` 在开发者机器上运行，持有**账号级 API 凭据**、操作**生产域名的 DNS**、并把**本地开发服务暴露到公网**。风险主要来自四类：

| # | 威胁 | 后果 | 可能性 |
| --- | --- | --- | --- |
| T1 | 临时域名被搜索引擎/扫描器发现，开发服务无鉴权 | 源码、调试接口、环境变量泄漏 | 高 |
| T2 | API Token 泄漏（日志、`ps`、状态文件、shell history、CI 日志） | 攻击者可操作账号下隧道与 DNS | 中 |
| T3 | 清理逻辑误删非本工具创建的记录/隧道 | 生产域名解析中断 | 低但影响大 |
| T4 | 遗留的 CNAME 指向已删除隧道（dangling DNS） | 子域接管（subdomain takeover） | 中 |
| T5 | cloudflared 二进制被替换/下载源被污染 | 任意代码执行 | 低 |
| T6 | 多用户机器上状态/日志被他人读取 | 项目信息、域名、会话泄漏 | 低 |

## 安全默认值

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 子域名 | 随机后缀 | 不可预测；不默认使用可枚举的 `preview-<project>` |
| 主机名层级 | 一级子域 | 避免 Advanced Certificate 与通配符 |
| DNS 记录 | `proxied: true` | 隐藏源站、享受 Cloudflare 防护；隧道要求如此 |
| 自动停止 | 默认关闭 | 配置 `autoStopAfter` 后到点自动清理，缩短暴露窗口 |
| 清理 | 恒定开启，无配置开关 | 产品承诺；调试只能用 CLI `--keep`，且显著警告 |
| 自动打开浏览器 | 仅 TTY 且本机 | CI 不打开 |
| 日志敏感信息 | 脱敏 | Token/Authorization/secret 一律 `***` |
| 凭据位置 | 只读环境变量 | 配置文件与状态文件都不承载 Token |

## 凭据处理

### 最小权限 Token

只申请三项权限（详见 04）：

```text
Account · Cloudflare Tunnel · Edit
Zone    · DNS               · Edit
Zone    · Zone              · Read   （可选，用于按域名查 zone id）
```

建议：

- 为个人/团队单独创建 Token，命名 `flash-tunnel-<user>`，便于审计与吊销。
- 不要复用全局 API Key（`X-Auth-Email` + `X-Auth-Key`），本工具只支持 Bearer Token。
- 有条件时使用短期 Token（Cloudflare 支持设置过期时间），或 CI 中按 job 生成。
- 多 Zone 账号可再收紧到指定 Zone（Cloudflare 的 Zone 级资源权限可按 Zone 限定；Account 级 Tunnel 权限无法按 Zone 限定，这是平台限制）。

### 存储与传递

| 渠道 | 策略 |
| --- | --- |
| 环境变量 | **唯一入口**；`CLOUDFLARE_API_TOKEN` 只存在于进程环境 |
| `flash-tunnel.ts` | **不提供 token 字段**；配置里只能通过 `process.env` 间接读取 |
| 状态文件 | **禁止**写入任何 token/secret；只存 provider id 与资源 id |
| 日志 | 统一脱敏（`Bearer xxx`、`token=xxx`、JWT 形态） |
| `--json` | 不包含凭据字段 |
| cloudflared 参数 | **禁止** `--token` 出现在 argv；使用 `TUNNEL_TOKEN` 环境变量（同用户可见，但不出现在进程列表与崩溃转储的命令行） |
| shell history | 文档不提供「把 token 写进命令行」的示例；CLI 不接受 `--token` 参数 |

### 脱敏实现

```ts
const SECRET_PATTERNS = [
  /(Bearer\s+)[\w.-]+/gi,
  /(token["'\s:=]+)[\w.-]+/gi,
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // JWT
]
```

在 logger 的最外层统一处理（适配器与 core 都经过它），避免漏点。测试里用固定假 token 断言输出中不出现原值。

## 暴露面与使用建议

`flash-tunnel` 暴露的是**开发服务器**，它通常：

- 没有身份认证；
- 暴露源码与 source map；
- 暴露 HMR/WebSocket 与调试端点；
- 把 `VITE_*`、`NEXT_PUBLIC_*` 等前缀变量打进前端产物；
- 可能挂着本地数据库管理面板、Storybook、API mock。

因此：

1. **优先 `preview` 而不是 `dev`**（默认策略），减少调试面。
2. 不要把带真实数据的后台、`.env` 面板、数据库 UI 暴露出去；需要时用 Cloudflare Access（后续扩展点）或临时 Basic Auth 反向代理。
3. 分享链接时提醒对方「这是临时地址，可能随时失效」；避免发到公开渠道。
4. 需要严格限时就用 `autoStopAfter`（到点自动下线并清理），不要依赖对方自觉。
5. 域名本身不是安全边界：随机后缀降低被扫概率，但不等于鉴权。

风险提示会在输出中体现（`dev` 模式、`--hostname` 固定名、`--keep`、`--overwrite`、`--allow-multilevel` 都会打印显著警告）。

## 误删保护

原则：**只删除本会话创建、且能被证明归属的资源。**

| 保护 | 实现 |
| --- | --- |
| 删除按 id | 不用域名/前缀做删除条件 |
| 归属标记 | DNS `comment = flash-tunnel:<sessionId>`；隧道名含 `flash-tunnel-` 前缀 + 状态文件 id |
| 二次校验 | 删除前 `find` 记录并比对 comment；隧道按 id `GET` 后比对 name |
| 冲突即失败 | 目标主机名已有非本工具记录 → 默认报错，不覆盖 |
| 不改既有记录 | 不支持「更新已有 CNAME」；`overwrite` 仅删除本工具标记的记录后重建 |
| 不删通配符 | 代码层面禁止对 `*`、`@`、apex 域名执行删除 |
| dry-run | `clean --dry-run` 输出清单，人工确认 |
| 不跨项目自动清理 | 启动扫描只自动处理**当前项目**的 stale 会话 |

## DNS 残留与子域接管

- 正常退出删除记录；异常退出由 reaper/扫描兜底。
- 记录删除后 Cloudflare 侧立即失效，但递归 DNS 可能有缓存（TTL 1 + 橙云，通常几十秒）。
- 若发生「CNAME 指向已删除隧道」的残留，Cloudflare 返回 530，不会把流量转给第三方；真正的接管风险出现在 CNAME 指向第三方服务（如 GitHub Pages、S3）时，本工具只创建指向 `cfargotunnel.com` 的记录，风险较低。
- `doctor` 会列出「comment 含 flash-tunnel 但隧道不存在」的记录，提示清理。

## 供应链

| 项 | 措施 |
| --- | --- |
| cloudflared 自动下载 | 程序化选项，默认关闭；开启时固定版本、HTTPS、校验官方 release 的 sha256，校验失败即中止；下载目录 `~/.flash-tunnel/bin`（0700） |
| npm 依赖 | 提交 lockfile；`pnpm` 的 `minimumReleaseAge`（延迟采纳新版本）与 `trustPolicy: no-downgrade` 可参考现有仓库配置 |
| 构建产物 | 不执行 postinstall 脚本（`onlyBuiltDependencies` 白名单）；CI 使用 `--frozen-lockfile` |
| 配置加载 | 只加载项目内的 `flash-tunnel.ts`；`--config` 指向任意路径属于用户显式行为，启动时打印绝对路径 |
| 第三方适配器 | 明确提示「将执行项目内 node_modules 的代码」，等价于安装依赖的风险；本地 `.ts` 适配器加载前打印路径 |

## 本地文件权限

| 文件 | 权限 |
| --- | --- |
| `~/.flash-tunnel/` | `0700` |
| `sessions/*.json`、`projects/<key>/*.json`、日志 | `0600` |
| `lock.json` | `0600`，仅含 pid 与 sessionId |

项目目录不写入任何运行时文件，因此 `init` 不再修改 `.gitignore`；状态文件（含域名、账号 id、记录 id）只落在 `~/.flash-tunnel/projects/<key>/` 下。旧版本遗留的项目内 `.flash-tunnel/` 不再写入，仅在读取旧会话时兼容，可手动删除。

## CI 中的注意事项

- Secret 用仓库/环境保护，禁止 `echo`；`--json` 输出到文件后注意 artifact 保留策略。
- `--yes` 避免交互；`--no-open`；`--json`。
- 任务结束务必发送 `SIGINT` 并 `wait`，检查退出码；CI 被取消时（`cancel`）可能来不及清理，需配合定时任务或 `clean --stale`（需要 Token）。
- 日志里禁止打印环境变量全集（错误报告只列关键键名）。

## 残余风险

| 风险 | 残余程度 | 说明 |
| --- | --- | --- |
| `kill -9` 后资源残留 | 中 | 下次运行或手动 `clean` 才能回收；`doctor` 会提示 |
| 同机其它进程读取环境变量 | 低 | 同用户进程本就可读；不额外扩大 |
| Cloudflare 侧看到明文流量 | 中 | TLS 在 Cloudflare 终止；敏感数据不应经临时链接传输 |
| 固定域名被外部记住 | 低 | 用随机后缀 + 短 `autoStopAfter` 降低；固定域名需用户显式选择 |
| API Token 权限过宽 | 中 | 平台限制（Account 级 Tunnel 权限）；建议单独 Token + 定期轮换 |
