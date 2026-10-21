import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { startPreviewSession } from '@flash-tunnel/core'

const cwd = process.argv[2]
if (!cwd) {
  throw new Error('missing cwd')
}

let tunnelProcess

const tunnel = {
  kind: 'tunnel',
  id: 'crash-fake',
  apiVersion: 1,
  capabilities: {
    modes: ['named'],
    publicHostname: 'custom',
    requiresDns: false,
    concurrent: true
  },
  preflight: async () => {},
  provision: async (_ctx, spec) => ({
    provider: 'crash-fake',
    tunnelId: 'tunnel-crash',
    name: spec.name,
    publicUrl: spec.localUrl,
    dns: {
      type: 'CNAME',
      target: 'tunnel-crash.cfargotunnel.com',
      proxied: true
    },
    secrets: {},
    meta: { localUrl: spec.localUrl }
  }),
  start: async (_ctx, handle) => {
    tunnelProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    handle.meta = { ...handle.meta, processPid: String(tunnelProcess.pid) }
  },
  waitReady: async (_ctx, handle) => ({
    state: 'connected',
    connections: 1,
    publicUrl: handle.publicUrl
  }),
  stop: async () => {
    tunnelProcess?.kill('SIGKILL')
  },
  deprovision: async () => {}
}

const dns = {
  kind: 'dns',
  id: 'crash-dns',
  apiVersion: 1,
  capabilities: {
    recordTypes: ['CNAME'],
    proxied: true,
    ttl: true,
    comment: true,
    lookupByName: true
  },
  preflight: async () => {},
  ensure: async () => ({
    provider: 'crash-dns',
    zoneId: 'zone-crash',
    recordId: 'record-crash',
    name: 'crash.example.com',
    type: 'CNAME',
    content: 'tunnel-crash.cfargotunnel.com',
    proxied: true
  }),
  remove: async () => {},
  find: async () => []
}

async function main() {
  const session = await startPreviewSession({
    cwd,
    config: { server: { command: 'node server.mjs', port: 0 } },
    adapters: { tunnel, dns },
    mode: 'named',
    hostname: 'crash.example.com',
    zone: 'example.com',
    verifyTimeoutMs: 10_000
  })

  const serverProcessPid = Number(
    session.server.output
      .find(line => line.startsWith('SERVER_PID '))
      ?.slice('SERVER_PID '.length)
  )

  writeFileSync(join(cwd, 'pids.json'), JSON.stringify({
    sessionId: session.sessionId,
    serverPid: session.server.pid,
    serverProcessPid,
    tunnelPid: tunnelProcess.pid
  }))

  process.stdout.write(`READY ${session.sessionId} ${session.server.pid} ${tunnelProcess.pid}\n`)

  if (process.env.GRACEFUL === '1') {
    const shutdown = async (signal) => {
      await session.stop().catch(() => {})
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
  }
  else {
    // Simulate a hard crash: ignore termination signals and wait to be killed.
    process.on('SIGTERM', () => {})
  }

  setInterval(() => {}, 1000)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
