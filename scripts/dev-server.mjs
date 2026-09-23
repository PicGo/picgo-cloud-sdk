import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

export function readDevConfig(env = process.env) {
  const api = new URL(env.PICGO_API_URL || 'https://dev-api.picgo.app')
  if (!['https:', 'http:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
    throw new Error('PICGO_API_URL must be an HTTP(S) URL without credentials, query, or hash')
  }
  const port = Number(env.PICGO_DEV_PORT || 5175)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PICGO_DEV_PORT must be between 1 and 65535')
  return { apiUrl: api.href.replace(/\/+$/, ''), port }
}

export function createDevServer(config) {
  // Serve an explicit allowlist. Never expose .env or the rest of the workspace.
  const files = new Map([
    ['/', ['../examples/basic.html', 'text/html; charset=utf-8']],
    ['/examples/basic.html', ['../examples/basic.html', 'text/html; charset=utf-8']],
    ['/dist/index.js', ['../dist/index.js', 'text/javascript; charset=utf-8']],
    ['/dist/index.js.map', ['../dist/index.js.map', 'application/json']],
  ])
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return
    }
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/config.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ apiUrl: config.apiUrl }))
      return
    }
    const entry = files.get(pathname)
    if (!entry) { response.writeHead(404); response.end('Not found'); return }
    try {
      const content = await readFile(new URL(entry[0], import.meta.url))
      response.writeHead(200, { 'Content-Type': entry[1] })
      response.end(request.method === 'HEAD' ? undefined : content)
    } catch {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Build output is not ready. Run pnpm build and reload.')
    }
  })
}
