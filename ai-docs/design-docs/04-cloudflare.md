# 04 · Cloudflare 适配器设计

本文描述 `@flash-tunnel/adapter-cloudflare` 的实现细节，以及首期唯一可用的组合：**Cloudflare Tunnel（named）+ Cloudflare DNS**。

## 前置条件

| 条件 | 说明 | 缺失时的表现 |
| --- | --- | --- |
| Zone 已接入 Cloudflare 且状态 Active | 域名 NS 指向 Cloudflare | 创建 DNS 记录返回错误，隧道建了也没用 |
| Zone 与隧道在**同一个账号**下 | `<tunnel-id>.cfargotunnel.com` 只在同账号代理内可解析 | 域名 530/1033 |
| API Token 具备所需权限 | 见下表 | 401/403 |
| `cloudflared` 可执行 | 建议使用近一年内的版本（需支持远端配置与 `TUNNEL_TOKEN`） | spawn 失败或连接被拒 |
| 出站 7844/UDP 可达 | cloudflared 与 Cloudflare 边缘的 QUIC 通道 | 连接超时（可回退 http2） |

### Token 权限

| 类型 | 资源 | 权限 | 用途 |
| --- | --- | --- | --- |
| Account | Cloudflare Tunnel | Edit | 创建/配置/删除隧道 |
| Zone | DNS | Edit | 创建/删除 CNAME |
| Zone | Zone | Read | 按域名查 Zone ID（可选，若直接配置 `zoneId` 可省） |

Token 只作用于指定账号；若账号下有多个 Zone，建议在配置中写死 `zone`，避免歧义。

## 需要创建的资源

一次会话在 Cloudflare 侧产生三类状态：

```text
1. Tunnel（控制面资源）        POST /accounts/{account_id}/cfd_tunnel
2. Ingress 配置（隧道远端配置） PUT  /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
3. DNS 记录（CNAME + 橙云）     POST /zones/{zone_id}/dns_records
```

三者的删除顺序与创建相反：DNS 记录 → 隧道（隧道要求无活跃连接，所以先停 cloudflared）。

## API 约定

- Base URL：`https://api.cloudflare.com/client/v4`
- 认证：`Authorization: Bearer <CLOUDFLARE_API_TOKEN>`
- 响应包络：

```json
{
  "success": true,
  "errors": [{ "code": 81057, "message": "The record already exists." }],
  "messages": [],
  "result": {}
}
```

适配器只信任 `success === true`，否则把 `errors[0]` 映射为 `AdapterError`（保留 code 与 message，附 `hint`）。

- 超时：单请求 15s；创建/删除类请求失败按 `retriable` 重试最多 3 次（指数退避 0.5s/1s/2s）。
- 限流：Cloudflare 对 API 有速率限制（按 Token/账号），批量清理时串行请求，避免并发打爆。

### 端点清单

| 步骤 | 方法与路径 | 请求体要点 | 幂等策略 |
| --- | --- | --- | --- |
| 验证 Token | `GET /user/tokens/verify` | — | 只读 |
| 解析账号 | `GET /accounts` | — | 单账号直接用；多账号必须配置 |
| 解析 Zone | `GET /zones?name={zone}` | — | 结果为空/非 active → 报错 |
| 冲突检查 | `GET /zones/{zone_id}/dns_records?name={fqdn}` | — | 有同名记录 → 默认报错（可 `overwrite`） |
| 创建隧道 | `POST /accounts/{account_id}/cfd_tunnel` | `{ "name": "...", "config_src": "cloudflare" }` | 本工具不依赖幂等，失败即回滚 |
| 取 Token（兜底） | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token` | — | 创建响应没带 token 时调用 |
| 写 ingress | `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` | `{ config: { ingress: [...] } }` | 覆盖写，天然幂等 |
| 建 DNS | `POST /zones/{zone_id}/dns_records` | `{ type: "CNAME", name, content, proxied: true, ttl: 1, comment }` | 创建前已做冲突检查 |
| 查隧道状态 | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}` | — | 轮询 |
| 清理连接 | `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` | 可选 `?client_id=` | 全量清理 |
| 删 DNS | `DELETE /zones/{zone_id}/dns_records/{record_id}` | — | 404 视为成功 |
| 删隧道 | `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}` | — | 404 视为成功；有活跃连接会失败 |
| 扫描遗留 | `GET /zones/{zone_id}/dns_records?comment={marker}` + `GET /accounts/{account_id}/cfd_tunnel?name=...` | — | 仅用于恢复 |

> `ttl: 1` 表示 Cloudflare 自动 TTL；橙云记录的 TTL 由 Cloudflare 接管，实际值无意义。
>
> 账号解析与 Zone 解析都依赖额外的读权限。若 Token 只能操作单个账号/Zone，`GET /accounts` 或 `GET /zones?name=` 可能返回 403/空结果；此时必须显式配置 `accountId` / `zoneId`，错误提示中要给出这条指引，而不是笼统报「Token 无效」。

## 创建流程

```text
preflight
 ├─ GET /user/tokens/verify            → 失败：AUTH_INVALID（提示 Token 无效/过期）
 ├─ 解析 accountId                     → 失败：ACCOUNT_NOT_FOUND（提示设置 CLOUDFLARE_ACCOUNT_ID）
 ├─ 解析 zoneId + status               → 失败：ZONE_NOT_FOUND / ZONE_NOT_ACTIVE
 ├─ GET dns_records?name=fqdn          → 有记录：RECORD_CONFLICT（提示换名或 overwrite）
 └─ 检查 cloudflared 可执行             → 失败：PROCESS_SPAWN_FAILED（提示安装命令）

provision
 ├─ POST /cfd_tunnel  { name, config_src: "cloudflare" }
 │    └─ result.id, result.token（若缺失 → GET /token）
 ├─ PUT /configurations
 │    └─ ingress: [{ hostname, service, originRequest? }, { service: "http_status:404" }]
 └─ 返回 handle { tunnelId, dns: { type: 'CNAME', target: `${id}.cfargotunnel.com`, proxied: true }, secrets: { token } }

dns.ensure
 └─ POST /dns_records { type: CNAME, name: fqdn, content: `${id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: `flash-tunnel:${sessionId}` }

tunnel.start
 └─ spawn cloudflared tunnel run（token 经环境变量 TUNNEL_TOKEN 传入）

waitReady
 ├─ 轮询 GET /cfd_tunnel/{id}  直至 status=healthy 且 connections.length > 0（默认 30s，3s 间隔）
 └─ 公网探测（core 负责）      直至 https://{fqdn} 返回非 5xx（默认 60s，2s 间隔）
```

### 请求示例

创建隧道：

```http
POST /client/v4/accounts/{account_id}/cfd_tunnel
{
  "name": "flash-tunnel-my-app-k3f9",
  "config_src": "cloudflare"
}
```

响应关键字段：

```json
{
  "success": true,
  "result": {
    "id": "c1744f8b-faa1-48a4-9e5c-02ac921467fa",
    "name": "flash-tunnel-my-app-k3f9",
    "status": "inactive",
    "remote_config": true,
    "token": "eyJhIjoiNWFiNGU5Z..."
  }
}
```

写 ingress：

```http
PUT /client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
{
  "config": {
    "ingress": [
      {
        "hostname": "my-app-k3f9.example.com",
        "service": "http://127.0.0.1:5173",
        "originRequest": {}
      },
      { "service": "http_status:404" }
    ]
  }
}
```

- `ingress` **必须**以 catch-all 结尾（`http_status:404` 或 `http://...`），否则 API 报配置非法。
- 本地服务是 HTTPS（自签证书）时加 `"originRequest": { "noTLSVerify": true }`。
- 若源站对 `Host` 头敏感（例如 Vite 的 `server.allowedHosts`），可加 `"originRequest": { "httpHostHeader": "localhost:5173" }`，但这会改变应用看到的 Host，可能影响 cookie/跳转，作为兜底而非默认。
- WebSocket（HMR、SSE）由 cloudflared 自动透传，无需额外配置。

建 DNS：

```http
POST /client/v4/zones/{zone_id}/dns_records
{
  "type": "CNAME",
  "name": "my-app-k3f9.example.com",
  "content": "c1744f8b-faa1-48a4-9e5c-02ac921467fa.cfargotunnel.com",
  "proxied": true,
  "ttl": 1,
  "comment": "flash-tunnel:ft_m3k9x_7fa2"
}
```

`comment` 是归属标记，也是孤儿清理的检索键；Cloudflare 的 DNS 记录支持 `comment` 与 `tags`，两者都可用来标记本工具创建的记录。

## 启动 cloudflared

```bash
# 推荐：token 走环境变量，不出现在进程参数里
TUNNEL_TOKEN=<token> cloudflared tunnel run
```

- 远程管理模式（`config_src: cloudflare`）下，`cloudflared tunnel run --token <token>` 与 `TUNNEL_TOKEN` 等价；**优先用环境变量**，避免 `ps`/任务管理器泄漏。
- 不写日志文件时 cloudflared 把日志打到 stderr；我们捕获并按 `debug` 级别转发，同时保留最近 200 行用于报错附件。
- 常用参数：`--no-autoupdate`（避免运行中自我替换）、`--loglevel info`（需要诊断时 `debug`）、`--protocol auto`（QUIC 失败自动回退 HTTP/2）。
- 进程生命周期归 core 管：停止时先 `SIGTERM`，5s 未退出再强杀进程树（Windows 用 `taskkill /PID <pid> /T /F`）。

### 二进制来源

| 方式 | 行为 |
| --- | --- |
| PATH 中已存在 | 直接使用，检查 `cloudflared --version` 是否可执行 |
| 配置 `cloudflaredPath` | 使用指定路径（支持绝对路径与 `~/`） |
| 自动下载（程序化选项，不开放配置） | 从 GitHub Releases 按 platform/arch 下载到 `~/.flash-tunnel/bin/`，校验 sha256，写入可执行权限；失败则回退到「提示用户手动安装」 |

自动下载默认关闭：它引入网络依赖与供应链风险，MVP 先用「检测 + 明确提示」。

## 健康检查与公网验证

分两层，缺一不可：

1. **控制面**：`GET /cfd_tunnel/{id}` 的 `status === 'healthy'` 且 `connections.length > 0`。只看到 `inactive` 说明 cloudflared 还没连上。
2. **数据面**：对 `https://{fqdn}` 发 `GET`（`redirect: manual`），接受 `200–499`（401/403/404 也证明链路通了），拒绝 5xx 与网络错误。持续到超时（默认 60s）。

常见中间态与含义：

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `530` / `1033` | 隧道未连接或 DNS 已指向但无 connector | 继续等待，超时后检查 cloudflared 日志 |
| `502` | cloudflared 连上了，但源站不可达 | 检查本地服务端口/HTTPS 证书 |
| `403 Blocked request. This host is not allowed.` | Vite/其它 dev server 的 Host 白名单 | 提示配置 `server.allowedHosts` 或 ingress `httpHostHeader` |
| DNS 解析不到 | 记录未生效/递归缓存 | 用 DoH 查询（`https://cloudflare-dns.com/dns-query?name=...&type=CNAME`）诊断 |

验证通过后输出 URL；`verify` 的耗时单独记录，用于诊断「Cloudflare 侧慢」还是「本地慢」。

## 清理流程

```text
1. 停止 cloudflared（SIGTERM → 5s → kill tree）
2. 等待隧道连接断开：轮询 GET /cfd_tunnel/{id} 直至 connections 为空（最多 10s）
   若仍有连接：DELETE /cfd_tunnel/{id}/connections 主动清理，再轮询一次
3. 删除 DNS 记录：DELETE /zones/{zone_id}/dns_records/{record_id}（404 = 已删）
4. 删除隧道：DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}（404 = 已删）
5. 清理状态文件中的会话条目
```

要点：

- **顺序不能反**：先删隧道会因「隧道仍有活跃连接」被拒绝；先删 DNS 是安全的（连接断开后域名自然 530，不会误伤别人）。
- 删除隧道失败（`TUNNEL_DELETE_BLOCKED`）时，先调 connections 清理再重试；仍失败则把会话标记为 `dangling`，交给下次启动扫描或 `flash-tunnel clean`。
- 所有删除都按 **id** 执行，不做「按名字前缀批量删除」；名字只用于恢复扫描时的候选发现。
- DNS 删除是异步生效的，测试/验收不要立即断言解析失败，等待 10–60s 或用 DoH 轮询。

## quick 模式（降级）

当没有 API Token（或用户显式 `--mode quick`）时：

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

- 输出 `https://<random>.trycloudflare.com`，从 stderr 解析（正则 `https://[a-z0-9-]+\.trycloudflare\.com`）。
- 不创建 DNS、不创建 API 资源；退出时只需停止进程，域名随之失效。
- 能力声明不同：`publicHostname: 'assigned'`、`requiresDns: false`，因此 `resolveAdapters` 会跳过 DNS 阶段（见 03 的 C5）。
- 限制：域名随机且不可控、无 SLA、可能被限流；只作为「没有 Token 时的可用方案」，UI 中明确标注「临时域名，无法使用自有域名」。

## 限制与坑

1. **子域名层级**：`a.example.com` 用 Universal SSL 即可；`a.b.example.com` 属于多级子域，需要 Advanced Certificate。默认生成一级子域，`doctor` 对多级配置给出警告。
2. **必须橙云**：CNAME 指向 `cfargotunnel.com` 时必须是 proxied，DNS-only 不会生效。
3. **Zone 必须在同一账号**：跨账号的 Zone 无法指向该隧道的 `cfargotunnel.com`。组合校验里 `providerAffinity: ['cloudflare']` 就是为此。
4. **重复主机名**：同一域名同时只能有一条 CNAME。默认随机后缀避免冲突；固定子域（`subdomain` 写死）需要先回收本工具创建的旧记录，存在短暂不可用窗口。
5. **浏览器/系统 DNS 缓存**：删除记录后本机可能仍能解析一段时间，验收时不要误判为「没删掉」。
6. **Cloudflare 代理缓存**：复用主机名时可能命中旧 HTML；默认随机主机名天然规避。
7. **Vite 开发服务器**：新版本默认校验 Host（`allowedHosts`），公网域名会被 403；需要用户配置或用 `httpHostHeader` 兜底。HMR 通过隧道时还可能需要 `server.hmr.clientPort = 443`。这两条放进 `doctor` 的提示。
8. **本地 HTTPS**：自签证书需要 `noTLSVerify`；否则 cloudflared 报证书错误。
9. **Windows**：`cloudflared` 不需要管理员权限即可 `tunnel run`；但进程树停止必须用 `taskkill /T`，否则会残留子进程。
10. **Token 泄漏面**：不要把 token 拼进命令行；错误日志、状态文件、`--json` 输出都要脱敏。
11. **API Token 可见范围**：Token 只能看到被授权账号下的资源；多账号环境必须显式 `accountId`，否则 `GET /accounts` 可能返回多个导致歧义。
12. **限流与并发**：同一 Token 高频创建/删除可能触发限流；`retriable` 重试要带抖动，避免多实例同时重试。

## 错误映射（实现时补齐）

| 来源 | 判定 | 用户提示方向 |
| --- | --- | --- |
| `success=false` + HTTP 401/403 | Token 无效或权限不足 | 列出需要的三条权限，附控制台链接 |
| `success=false` + HTTP 404 | 账号/Zone/隧道/记录不存在 | 检查 `accountId`/`zone`/是否已被手动删除 |
| `errors[].code = 81057` | DNS 记录已存在 | 换随机后缀或开启 `overwrite` |
| HTTP 429 | 限流 | 等待后重试；提示降低并发 |
| `GET /cfd_tunnel` 超时 | 隧道未连上 | 展示 cloudflared 最近日志与网络检查建议 |
| `DELETE /cfd_tunnel` 失败且提示连接 | 有活跃连接 | 自动执行 connections 清理后重试一次 |

> 错误码表以 Cloudflare 实际返回为准，实现阶段用真实账号回归一次并固化到 `packages/adapter-cloudflare/src/errors.ts`。

## 与 Cloudflare Access 的关系（后续）

MVP 不做访问控制，域名建好即公网可访问。后续可在适配器增加可选步骤：创建 Access Application + Policy（邮箱/OTP），作为 `tunnel.capabilities` 之外的独立 `access` 扩展点。设计上不把 Access 塞进 DNS 或隧道契约，避免职责混淆。
