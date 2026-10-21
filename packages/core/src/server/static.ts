import type { Server } from 'node:http'
import type { ServerHandle, ServerPlan } from './types'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error)
    }

    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolvePort(typeof address === 'object' && address ? address.port : port)
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function listenOnFreePort(server: Server, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    try {
      return await listen(server, port)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error
      }
    }
  }

  throw new Error(`No free port found between ${startPort} and ${startPort + 19}`)
}

export async function startStaticServer(plan: ServerPlan): Promise<ServerHandle> {
  if (!plan.dir) {
    throw new Error('Static server requires a directory')
  }

  const root = resolve(plan.dir)
  const indexFile = resolve(root, 'index.html')

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(requestUrl.pathname)
      const target = resolve(root, `.${pathname}`)

      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }

      let filePath = target
      let fileStat = await stat(filePath).catch(() => undefined)

      if (!fileStat?.isFile()) {
        const isRootOrDirectory = pathname === '/' || pathname.endsWith('/')
        const acceptsHtml = request.headers.accept?.includes('text/html')
        if (!isRootOrDirectory && (!acceptsHtml || extname(pathname))) {
          response.writeHead(404)
          response.end('Not Found')
          return
        }
        filePath = indexFile
        fileStat = await stat(filePath).catch(() => undefined)
      }

      if (!fileStat?.isFile()) {
        response.writeHead(404)
        response.end('Not Found')
        return
      }

      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      })
      createReadStream(filePath).pipe(response)
    }
    catch {
      response.writeHead(500)
      response.end('Internal Server Error')
    }
  })

  const port = await listenOnFreePort(server, plan.port || 4173)

  return {
    plan,
    url: `http://127.0.0.1:${port}`,
    port,
    startedByUs: true,
    output: [],
    stop: () => new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => {
        if (error) {
          rejectStop(error)
        }
        else {
          resolveStop()
        }
      })
    })
  }
}
