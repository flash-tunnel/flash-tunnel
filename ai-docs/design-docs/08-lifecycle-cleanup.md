# 08 · 生命周期、回滚与清理

清理是这个产品的核心承诺，也是最容易出错的部分。本文定义：正常退出、被信号打断、未捕获异常、进程被强杀、机器重启后，分别如何保证「不留资源」。

## 会话与状态持久化

一次运行 = 一个会话（`sessionId = ft_<base36时间>_<4位随机>`）。状态文件有两层：

```text
<project>/.flash-tunnel/
├─ session.json          # 当前会话（原子写），退出成功后删除
├─ lock.json             # 项目锁，防止同项目并发
└─ logs/
   ├─ server-<sessionId>.log
   └─ tunnel-<sessionId>.log

~/.flash-tunnel/
├─ sessions/<sessionId>.json   # 全局索引，供跨项目/崩溃后扫描
├─ bin/                        # 可选：cloudflared 自动下载目录
└─ logs/reap-<sessionId>.log   # reaper 日志
```

### session.json

```json
{
  "version": 1,
  "sessionId": "ft_m3k9x_7fa2",
  "pid": 24812,
  "projectRoot": "D:\\Projects\\my-app",
  "startedAt": "2026-10-21T06:52:40.000Z",
  "heartbeatAt": "2026-10-21T06:53:10.000Z",
  "state": "running",
  "configSource": "D:\\Projects\\my-app\\flash-tunnel.ts",
  "server": {
    "url": "http://127.0.0.1:4173",
    "command": "pnpm preview",
    "cwd": "D:\\Projects\\my-app",
    "pid": 24830,
    "startedByUs": true
  },
  "tunnel": {
    "provider": "cloudflare",
    "tunnelId": "c1744f8b-faa1-48a4-9e5c-02ac921467fa",
    "name": "flash-tunnel-my-app-k3f9",
    "publicUrl": "https://my-app-k3f9.example.com"
  },
  "processes": [
    { "kind": "cloudflared", "pid": 24844 }
  ],
  "dns": {
    "provider": "cloudflare",
    "zoneId": "023e105f4ecef8ad9ca31a8372d0c353",
    "recordId": "372e67954025e0ba6aaa6d586b9e0b59",
    "hostname": "my-app-k3f9.example.com"
  },
  "expiresAt": "2026-10-21T10:52:40.000Z",
  "cleanup": { "required": true, "attempts": 0, "inProgress": false, "kept": false }
}
```

写入规则：

- 每个资源创建成功后**立即**原子写（写入 `session.json.tmp` 后 `rename`）。
- **绝不存 token/secret**。cloudflared token 只在内存与子进程环境变量中。
- POSIX 下文件权限 `0600`、目录 `0700`；Windows 依赖用户目录 ACL。
- 心跳每 15s 更新 `heartbeatAt`，用于区分「进程活着但卡住」与「进程已死」。

## 项目锁

`lock.json`：

```json
{ "sessionId": "ft_m3k9x_7fa2", "pid": 24812, "acquiredAt": "..." }
```

- 启动时尝试创建；已存在且 pid 存活 → 报错「该项目已有会话在运行」，给出会话 id 与停止方式。
- 已存在但 pid 不存在、或心跳超过 90s → 视作 stale lock，回收并继续。
- 退出时删除锁；删除失败不影响退出。

## 正常退出流程

```text
触发（Ctrl+C / SIGTERM / q / autoStopAfter 到期 / 内部错误 / 子进程退出）
  │
  ├─ 停止 spinner、恢复光标（spinner 以 handleSignals: false 创建）
  ├─ 设置 abort signal，阻止新的创建步骤
  ├─ 状态 → tearing-down，账本冻结
  ├─ 逆序执行 dispose（每步独立超时与重试）：
  │   1. tunnel.stop      停止 cloudflared（SIGTERM → 5s → kill tree）
  │   2. 等待连接排空      core 轮询 status/API，直至连接数归零（≤10s，失败则清理 connections）
  │   3. dns.remove        删除 DNS 记录（404 视为成功）    ← --keep 时跳过
  │   4. tunnel.deprovision 删除隧道（404 视为成功）        ← --keep 时跳过
  │   5. server.stop      仅当 startedByUs
  │   6. 删除 session.json / 全局 sessions 条目 / lock.json  ← --keep 时保留并标记 kept
  ├─ 汇总结果 → cleanup:done 事件
  └─ exit(原错误码 / 0 / 8 / 130 / 143)
```

超时预算是内部常量（总 30s），不开放配置；`--keep` 只影响第 3、4、6 步。

| 步骤 | 单步超时 | 重试 |
| --- | --- | --- |
| 停止进程 | 8s（含 5s 宽限） | 1 |
| 等待连接断开 | 10s | 轮询 |
| 清理连接 | 10s | 2 |
| 删除 DNS | 10s | 3（仅 retriable） |
| 删除隧道 | 10s | 3（仅 retriable） |
| 总计 | 30s | — |

超过总预算立即退出并写 `cleanup.required = true`，由下次启动扫描或手动 `clean` 收尾。

## 自动停止（autoStopAfter）

- 配置 `autoStopAfter`（或 `--auto-stop`）后，在进入 `running` 时计算 `expiresAt` 并写入状态文件。
- 到点触发与 `q` 相同的正常退出路径：停止进程 → 等待连接排空 → 删 DNS → 删隧道 → 退出码 0。
- 清理前先 `spinner.stop()` 并打印一行提示，避免计时器回调打断 spinner 的光标状态。
- 计时器不持久化到磁盘，重启由 `expiresAt` + 进程存活判断决定：进程已死且已过期 → 按普通孤儿清理。
- 与 SIGINT 的竞态由单一 `abort` 控制器收口：谁先触发谁负责清理，另一个成为 no-op。

## 保留资源（--keep）

调试隧道或 DNS 配置时使用：

```text
flash-tunnel --keep
```

- 停止 cloudflared 与本地服务，**不删除** DNS/隧道。
- 状态文件保留并标记 `cleanup.kept = true`，`clean` 能发现它。
- 输出显著警告与手动清理命令：
  `flash-tunnel clean --session ft_m3k9x_7fa2`
- `--keep` 只能从 CLI 传入，不提供配置文件开关，避免被提交进仓库后影响同事。

## 信号与崩溃矩阵

| 事件 | 进程状态 | 处理 | 资源是否会残留 |
| --- | --- | --- | --- |
| `Ctrl+C`（SIGINT） | 运行中 | 走正常清理，退出码 130 | 否（清理失败则 8） |
| SIGTERM / SIGQUIT | 运行中 | 同上，退出码 143 | 否 |
| SIGHUP（终端关闭） | 运行中 | 同 SIGTERM | 否 |
| 未捕获异常 / unhandledRejection | 运行中 | 记录错误 → 自动清理 → 退出码 1 | 否 |
| 本地服务意外退出 | 运行中 | 判定为会话结束 → 清理 → 退出码 3 | 否 |
| cloudflared 意外退出 | 运行中 | 停止会话 → 清理 DNS/隧道 → 退出码 5 | 否 |
| `autoStopAfter` 到期 | 运行中 | 提示并走正常清理 → 退出码 0 | 否 |
| `--keep` 退出 | 运行中 | 只停进程，保留 DNS/隧道并标记 kept | **是（显式选择）** |
| `kill -9` / 任务管理器结束 | 立即 | 无机会执行清理 | **是** → 下次启动扫描 |
| 机器断电/休眠重启 | — | 同上 | **是** → 扫描 |
| 清理过程中被再次 Ctrl+C | — | 第二次信号立即退出，保留状态文件 | **可能** → reaper/扫描 |

### 为什么 `process.on('exit')` 不够

`exit` 回调只能执行同步代码，无法等待 HTTP 请求。策略是「三层」：

1. **优雅层**：信号处理里 `await cleanup()`，完成后再 `process.exit(code)`。
2. **同步兜底层**：`process.on('exit')` 中如果发现 `cleanup.required === true`，用 `spawnSync` 启动独立 reaper 进程（同步等待其结束），由它完成异步清理：

```ts
process.on('exit', () => {
  if (!needsReap()) return
  spawnSync(process.execPath, [cliPath, '__reap', '--session', sessionId], {
    stdio: 'ignore',
    timeout: 20_000,
    detached: false,
  })
})
```

3. **事后扫描层**：下次任意 `flash-tunnel` 启动（或 `clean --stale`）时，扫描全局 sessions，清理已死会话的残留。

`spawnSync` 在 `exit` 事件里合法（同步阻塞），但 Windows 上子进程继承控制台可能带来抖动，因此只在「确实需要」时执行，且限时 20s。

## reaper 设计

`flash-tunnel __reap --session <id>`：

1. 读取 `~/.flash-tunnel/sessions/<id>.json` 与项目内 `session.json`。
2. 若 pid 仍存活 → 直接退出（避免和正常会话抢资源）。
3. 重新构造适配器（凭据仍从环境变量读取；若 reaper 由原进程 spawn，环境变量会继承）。
4. 按账本逆序删除：
   - 杀 cloudflared/本地服务进程树（按记录的 pid + 启动时间做弱校验）。
   - `dns.remove`（用记录 id，先 `find` 校验 comment 归属）。
   - `tunnel.deprovision`（先查隧道是否仍存在；有连接先清理）。
5. 写日志到 `~/.flash-tunnel/logs/reap-<id>.log`。
6. 成功后删除状态文件；失败保留并标记 `cleanup.attempts++`。

凭据缺失（用户在新终端杀了进程、环境变量没继承）时，reaper 无法访问 API，只能：杀本地进程 + 标记 `dangling`，并在下次交互式启动时提示「需要 Token 才能清理，是否现在清理」。

## 启动时的孤儿扫描

```text
for each ~/.flash-tunnel/sessions/*.json:
  ├─ 读取；损坏 JSON → 移到 .corrupt/ 并警告
  ├─ 若 sessionId 属于当前项目 且 进程存活 且 心跳新鲜 → 跳过（可能是另一个终端）
  ├─ 若进程存活但心跳 > 90s → 视为假死，警告后清理
  ├─ 若进程已死：
  │    ├─ 同项目：自动清理（默认），日志说明「发现上次未清理的会话」
  │    └─ 其它项目：只提示，不自动删（避免误伤多项目并行）
  └─ 清理动作：
       ├─ 校验归属（DNS comment 含 sessionId；隧道名/标签匹配）
       ├─ 删除 DNS（按 id）→ 删除隧道
       └─ 删除状态文件
```

安全边界：

- **只处理带本会话标记的资源**：DNS 记录的 `comment` 必须等于 `flash-tunnel:<sessionId>`（或记录的 id 与状态文件一致）；隧道必须是状态文件里的 id。名字匹配只用于「发现候选」，删除前必须二次校验。
- 不自动清理超过 N 天、且无法校验归属的记录；只提示。
- `--no-sweep` 完全关闭自动扫描；`clean --stale` 手动触发。
- 多项目并行时，非当前项目的 stale 会话不自动处理，避免用户在 A 项目时把 B 项目的隧道删了。

## 幂等与并发

| 场景 | 防护 |
| --- | --- |
| 正常清理与 reaper 同时执行 | 状态文件里 `cleanup.inProgress = true` + 文件锁；后到者等待 3s 后复查，若已删除则退出 |
| 删除请求超时但服务端已成功 | 删除前 `GET` 校验存在性；删除后 404 视为成功；重试安全 |
| 同一项目两个终端同时启动 | 项目锁，第二个直接失败 |
| 同名 DNS 记录 | 默认随机后缀 + 创建前冲突检查；`overwrite` 需显式开启 |
| 上次会话资源已被手动删除 | 清理遇 404 视为成功，状态文件正常删除 |
| 上次会话资源被别的工具复用 | 只按 id 删除；若 id 已指向他人资源（极端情况），通过 comment 校验阻断 |

## 状态机与持久化时机

| 时刻 | 落盘内容 |
| --- | --- |
| 会话创建 | sessionId、pid、projectRoot、lock |
| 本地服务启动后 | server.pid/url/command/startedByUs |
| 隧道创建后 | tunnel.tunnelId/name |
| ingress 配置后 | tunnel.configured = true |
| DNS 创建后 | dns.zoneId/recordId/hostname |
| cloudflared 启动后 | processes[].pid |
| 进入 running | state = running；若配置 autoStopAfter 则写入 expiresAt |
| autoStopAfter 到期 | 触发正常清理（不单独落盘） |
| 开始清理 | cleanup.inProgress = true |
| `--keep` 退出 | cleanup.kept = true，保留状态文件 |
| 清理完成 | 删除文件 |

任何一步失败都立即进入回滚，回滚完成后删除状态文件；回滚失败则保留并标记 `cleanup.required = true`。

## 清理的正确性断言（供测试使用）

1. Cloudflare 侧不存在 `sessionId` 对应的 DNS 记录（按 comment 查询为空）。
2. Cloudflare 侧不存在状态文件里的 tunnelId（GET 返回 404）。
3. 本地不存在监听中的 server/cloudflared 进程（按 pid 检查）。
4. 项目目录无 `session.json`、无 `lock.json`，全局 sessions 无该 id。
5. 清理过程重复执行两次，结果一致且无报错（幂等）。

## 观测

- 每个清理步骤发 `cleanup:step` 事件，`--json` 下可被 CI 采集。
- 失败时写 `~/.flash-tunnel/logs/reap-<id>.log`，包含 HTTP 状态、错误码、重试次数（不含凭据）。
- `flash-tunnel clean --dry-run` 输出「将要删除」的清单（id、类型、创建时间、归属校验结果），供人工确认。
- 长期统计（可选）：`~/.flash-tunnel/stats.json` 记录会话数、清理成功/失败计数，`doctor` 展示。

## 已知边界

- `kill -9` 后如果用户再也不运行本工具，资源会保留到手动清理；这是任何本地 CLI 的固有限制。`expiresAt` 会写进状态文件，`doctor` 会把超期遗留列出来。
- 没有 Token 的 quick 模式无需清理 API 资源，进程退出即失效。
- 云厂商 API 故障时，清理只能尽力而为；此时退出码为 8 并保留可重试的状态文件。
