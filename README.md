# flash-tunnel

**Turn any local dev server into a shareable preview with one command.**  
Detect and start your local server, expose it through Cloudflare Tunnel, and clean up the DNS record, tunnel, and child processes on exit.

**English** | [简体中文](https://github.com/flash-tunnel/flash-tunnel/blob/main/README_CN.md)

[![npm version](https://img.shields.io/npm/v/flash-tunnel?style=flat-square&color=blue)](https://www.npmjs.com/package/flash-tunnel)
[![npm downloads](https://img.shields.io/npm/dm/flash-tunnel?style=flat-square)](https://www.npmjs.com/package/flash-tunnel)
[![license](https://img.shields.io/npm/l/flash-tunnel?style=flat-square)](https://github.com/flash-tunnel/flash-tunnel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/flash-tunnel?style=flat-square)](https://www.npmjs.com/package/flash-tunnel)

> Early preview (`0.0.x`). APIs and behavior may still change.

## Why flash-tunnel

- **Zero-config quick start** — `--mode quick` needs no Cloudflare token and returns a `*.trycloudflare.com` URL.
- **Custom domains** — create a Cloudflare Tunnel, write DNS, launch `cloudflared`, and verify the public URL in one command.
- **Cleans up after itself** — graceful exits, `Ctrl+C`, and `SIGTERM` clean resources in order; stale sessions are handled by a watchdog and a startup sweep.
- **Knows your project** — detects Vite, Next, Nuxt, Astro, SvelteKit, static sites, and more.
- **CI-friendly** — combine `--json`, `--ready-file`, `--on-ready`, and `--auto-stop` for unattended previews.

## How it works

1. Detects the framework, package manager, scripts, and port from your project.
2. Starts the local dev server (or attaches to an existing one).
3. Creates a Cloudflare Tunnel, writes the DNS record, and launches `cloudflared`.
4. Waits until the public URL answers and prints it.
5. Cleans up the tunnel, DNS record, and child processes when you exit.

## Requirements

- Node.js **>= 22.14**
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- A Cloudflare account (named mode only)

```bash
cloudflared --version
```

## Quick start

### Temporary URL (no token)

```bash
npx flash-tunnel --mode quick
```

### Custom domain (token required)

```bash
# macOS / Linux
export CLOUDFLARE_API_TOKEN=your_token_here

# Windows PowerShell
$env:CLOUDFLARE_API_TOKEN = "your_token_here"

npx flash-tunnel --zone example.com
```

Run the environment check and generate a config on first use:

```bash
npx flash-tunnel doctor
npx flash-tunnel init
```

## Install

```bash
# Run without installing
npx flash-tunnel

# Install globally
npm install -g flash-tunnel

# Add to a project (recommended for a pinned version)
pnpm add -D flash-tunnel
```

Then:

```bash
flash-tunnel --version
flash-tunnel doctor
```

## Commands

| Command | Description |
| --- | --- |
| `flash-tunnel` / `flash-tunnel start` | Detect the project, start the local server, create the tunnel, and wait |
| `flash-tunnel clean` | Clean leftover sessions (`--session` / `--project` / `--stale` / `--all --yes` / `--dry-run`) |
| `flash-tunnel doctor` | Check Node, config, token, zone, cloudflared, ports, and leftover sessions |
| `flash-tunnel init` | Create `flash-tunnel.ts` (runtime state stays outside the project) |
| `flash-tunnel providers` | List built-in adapters and their capabilities |

## Configuration

The config file is optional. Put it in the project root, or any parent directory up to the git root:

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

- Relative paths are resolved from the **config file's directory**.
- Precedence: **CLI > environment variables > `flash-tunnel.ts` > auto-detection**.
- `subdomain` supports `{project}`, `{branch}`, `{rand}`, `{rand:6}`, `{session}`, and `{ts}`.
- See the [configuration design](https://github.com/flash-tunnel/flash-tunnel/blob/main/ai-docs/design-docs/06-configuration.md) for every field and default.

### Common options

**Local server**

| Option | Description |
| --- | --- |
| `--cwd <dir>` | Project directory |
| `--config <path>` | Explicit `flash-tunnel.ts` |
| `--port <n>` | Preferred port |
| `--command <cmd>` | Explicit start command |
| `--url <url>` | Reuse an already running server |
| `--attach` | Attach only; requires `--url` |
| `--static [dir]` | Serve a static directory |
| `--dev` | Force the dev script |
| `--build` | Run the build script first |
| `--reuse` | Reuse a server already listening on the port |

**Tunnel and domain**

| Option | Description |
| --- | --- |
| `--mode named\|quick` | Tunnel mode |
| `--zone <domain>` | Cloudflare zone |
| `--hostname <fqdn>` | Full public hostname |
| `--subdomain <label>` | Subdomain template or literal label |
| `--allow-multilevel` | Allow multi-level subdomains (Advanced Certificate required) |
| `--overwrite` | Replace DNS records not created by this tool (dangerous) |
| `--auto-stop <dur>` | Stop and clean up after a duration, e.g. `30m` or `2h` |
| `--keep` | Keep the DNS record and tunnel on exit |

**Output and automation**

| Option | Description |
| --- | --- |
| `--dry-run` | Print the effective config and sources without creating resources |
| `--json` | Emit NDJSON on stdout; human logs go to stderr |
| `--silent` | Print errors only |
| `--ready-file <path>` | Write the ready payload to a file |
| `--on-ready <cmd>` | Run a command once ready, with environment variables injected |
| `--open` | Open the preview in a browser |
| `--verbose` | Stream dev server and cloudflared logs |
| `--no-color` / `--no-spinner` / `-y, --yes` | Disable color / spinner / prompts |

## Environment variables

| Variable | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (the only credential source) |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID; optional when the token sees one account |
| `CLOUDFLARE_ZONE_ID` | Zone ID; usually optional, the zone is resolved from its name |
| `FLASH_TUNNEL_ZONE` | Zone name, same as `domain.zone` |
| `FLASH_TUNNEL_HOSTNAME` | Full hostname; takes precedence over zone/subdomain |
| `FLASH_TUNNEL_MODE` | `named` or `quick` |
| `FLASH_TUNNEL_PORT` | Preferred port |
| `FLASH_TUNNEL_COMMAND` | Start command |
| `FLASH_TUNNEL_CLOUDFLARED` | Path to the `cloudflared` executable |
| `FLASH_TUNNEL_AUTO_STOP` | Auto-stop duration |
| `FLASH_TUNNEL_NO_OPEN` | Never open a browser, even with `--open` |
| `NO_COLOR` / `FORCE_COLOR` / `CI` | Color, spinner, and interaction fallbacks |

### Cloudflare token permissions

Create a **Custom token** at <https://dash.cloudflare.com/profile/api-tokens> with:

| Permission | Purpose |
| --- | --- |
| Account · Cloudflare Tunnel · Edit | Create/delete tunnels, write ingress, clean connections |
| Zone · DNS · Edit | Create/delete CNAME records and detect conflicts |
| Zone · Zone · Read | List zones and infer the domain |
| Account · Account Settings · Read | List accounts and infer the account ID |

> The Cloudflare dashboard may label `Edit` as `Write` now; they mean the same thing.

## Cleanup and recovery

On a normal exit, flash-tunnel:

1. Stops `cloudflared`
2. Waits for connections to drain
3. Deletes the DNS record
4. Deletes the tunnel
5. Stops the local server
6. Removes the session state and project lock

Other paths:

- `Ctrl+C` / `SIGTERM` / `SIGHUP`: clean up normally; exit code `130` / `143`.
- Second `Ctrl+C`: exits immediately, keeps the state file, and lets the watchdog or next run reap it.
- Force-kill / closed terminal: a detached watchdog tries to clean up after the main process exits; the next start also scans `~/.flash-tunnel/sessions/`.
- `--keep`: keeps the DNS record and tunnel and prints a manual cleanup command.
- Cleanup failure: exit code `8`; the state file is kept so `flash-tunnel clean` can retry.

```bash
# List leftover sessions
flash-tunnel clean

# Clean stale sessions for this project
flash-tunnel clean --stale

# Clean one session
flash-tunnel clean --session ft_xxxx

# Clean everything (confirmation required)
flash-tunnel clean --all --yes
```

## CI usage

```bash
READY_FILE="${TMPDIR:-/tmp}/flash-tunnel-ready.json"
npx flash-tunnel \
  --json \
  --ready-file "$READY_FILE" \
  --auto-stop 2h
```

- stdout contains only NDJSON; the `ready` event includes the public URL.
- `--ready-file` is convenient for polling from scripts; point it outside the checkout if you do not want files in the project.
- `--on-ready` receives `FLASH_TUNNEL_URL`, `FLASH_TUNNEL_LOCAL_URL`, `FLASH_TUNNEL_SESSION_ID`, and related variables.

```bash
# Read the URL from the ready file
node -p "require('$READY_FILE').url"
```

## Security

- The token is read from the environment only. It is never written to config, state, or argv.
- Runtime state and logs live in `~/.flash-tunnel/projects/<project-key>/`; nothing is written into the checkout. Inactive state is pruned after 7 days (`FLASH_TUNNEL_RETENTION_DAYS`).
- Grant only the four permissions above and set an expiry date.
- Random subdomains are used by default to avoid collisions and stale DNS caches.
- DNS records and tunnels are deleted by recorded ID and checked against the session marker.
- State directories use `0700`; state files use `0600`.
- `--overwrite` replaces records created by other tools. Use it only when you are sure.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot run cloudflared` | Install cloudflared or set `FLASH_TUNNEL_CLOUDFLARED` |
| `AUTH_INVALID` / `403` | The token is missing Tunnel/DNS/Zone permissions |
| `ACCOUNT_NOT_FOUND` | Set `CLOUDFLARE_ACCOUNT_ID` |
| `ZONE_NOT_FOUND` / `ZONE_NOT_ACTIVE` | Check `--zone` and make sure the domain is active in Cloudflare |
| `RECORD_CONFLICT` | Use another `--subdomain`, or `--overwrite` after verifying the old record |
| `No runnable script found` | Set `server.command`, use `--static dist`, or point `--cwd` at the app |
| Port already in use | Use `--port <n>` or `--reuse` |
| Terminal shortcuts do not respond | Click the terminal window and retry; the session ID is printed on startup |
| Cleanup exits with code `8` | Run `flash-tunnel clean --stale` again |

## Development

```bash
pnpm install
pnpm build
pnpm ft --version

pnpm lint
pnpm typecheck
pnpm test
```

Requires Node `>= 22.14` and pnpm `12.12.1`.

The end-to-end suite is opt-in and needs a real Cloudflare account:

```bash
FLASH_TUNNEL_E2E=1 pnpm test:e2e
```

## Design docs

The full design is in [ai-docs/design-docs](https://github.com/flash-tunnel/flash-tunnel/tree/main/ai-docs/design-docs) (Chinese).

## License

[MIT](https://github.com/flash-tunnel/flash-tunnel/blob/main/LICENSE)
