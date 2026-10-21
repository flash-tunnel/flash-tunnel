# flash-tunnel

在本地项目里执行 `npx flash-tunnel`，自动识别项目、拉起本地服务，并通过可插拔的 DNS / 隧道适配器把服务暴露到一个临时公网地址；退出时自动清理 DNS 记录与隧道。

> 当前版本：`0.0.0`（M0 脚手架）。正式版本 `0.1.0` 将在 CI 与 npm Trusted Publisher 配置完成后发布。

## 使用

```bash
# 临时预览（无需安装）
npx flash-tunnel

# 安装后写配置
pnpm add -D flash-tunnel
```

```ts
// flash-tunnel.ts
import { defineConfig } from 'flash-tunnel'

export default defineConfig({
  domain: { zone: 'example.com' }
})
```

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
