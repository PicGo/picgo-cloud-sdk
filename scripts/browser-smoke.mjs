// Local protocol fixture: no real tokens, cloud storage, or database writes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const pagePort = 41780
const apiPort = 41781
const storagePort = 41782
const sessions = new Map()
const media = new Map()
const counts = { puts: 0, preflights: 0, credentialsLeaked: 0, merges: 0 }
let sequence = 0
let failRegistration = true

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

function cors(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Signature')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS')
  response.setHeader('Access-Control-Expose-Headers', 'ETag')
  if (request.method === 'OPTIONS') {
    counts.preflights++
    response.writeHead(204)
    response.end()
    return true
  }
  return false
}

const api = createServer(async (request, response) => {
  try {
    if (cors(request, response)) return
    if (request.headers.cookie) counts.credentialsLeaked++
    if (request.headers.authorization !== 'Bearer browser-smoke-token') {
      json(response, { success: false, message: 'Unauthorized' }, 401)
      return
    }
    const url = new URL(request.url, `http://localhost:${apiPort}`)
    const input = await body(request)
    if (url.pathname === '/api/whoami') {
      json(response, { success: true, data: { userId: 'browser-user', user: 'Browser test', avatar: null, plan: 1, autoImport: false } })
    } else if (url.pathname === '/api/upload/presign' || url.pathname === '/api/upload/multipart/initiate') {
      const id = String(++sequence)
      const multipart = url.pathname.endsWith('initiate')
      sessions.set(id, { ...input, bytes: 0, parts: new Map(), merged: !multipart })
      const common = { success: true, objectKey: id, publicId: id }
      const headers = { 'Content-Type': 'image/png', 'X-Signature': 'signed' }
      if (multipart) {
        const partSize = 8 * 1024 * 1024
        const partCount = Math.ceil(input.sizeBytes / partSize)
        json(response, { ...common, uploadId: id, partSize, partCount,
          parts: Array.from({ length: partCount }, (_, index) => ({ partNumber: index + 1, method: 'PUT', headers,
            url: `http://localhost:${storagePort}/${id}/${index + 1}` })) })
      } else {
        json(response, { ...common, method: 'PUT', headers, uploadUrl: `http://localhost:${storagePort}/${id}/1` })
      }
    } else if (url.pathname === '/api/upload/multipart/complete') {
      const session = sessions.get(input.uploadId)
      const valid = input.parts.every(part => session.parts.get(part.partNumber) === part.etag)
      if (!valid || session.bytes !== session.sizeBytes) throw new Error('Incorrect multipart payload')
      session.merged = true
      counts.merges++
      json(response, { success: true })
    } else if (url.pathname === '/api/album-items/complete') {
      const session = sessions.get(input.objectKey)
      if (session.filename === 'large.png' && failRegistration) {
        failRegistration = false
        json(response, { success: false, code: 'TEST_REGISTRATION_FAILURE', message: 'Retry registration' }, 400)
        return
      }
      if (!session.merged || session.bytes !== session.sizeBytes) throw new Error('Registration before upload')
      const item = { id: input.publicId, imgUrl: `https://media.example/${input.publicId}.png`, fileName: input.filename }
      media.set(item.id, item)
      json(response, { success: true, data: { item } })
    } else if (url.pathname === '/api/album-items' && request.method === 'GET') {
      json(response, { success: true, data: { items: [...media.values()], total: media.size, limit: 20, offset: 0 } })
    } else if (url.pathname.startsWith('/api/album-items/') && request.method === 'PATCH') {
      const id = url.pathname.split('/').at(-1)
      const item = { ...media.get(id), ...input }
      media.set(id, item)
      json(response, { success: true, data: { item } })
    } else if (url.pathname.startsWith('/api/album-items/') && request.method === 'DELETE') {
      media.delete(url.pathname.split('/').at(-1))
      json(response, { success: true, data: { message: 'Deleted' } })
    } else if (url.pathname === '/counts') json(response, counts)
    else json(response, { success: false, message: 'Not found' }, 404)
  } catch (error) { json(response, { success: false, message: error.message }, 500) }
})

const storage = createServer(async (request, response) => {
  if (cors(request, response)) return
  if (request.headers.authorization || request.headers.cookie) counts.credentialsLeaked++
  if (request.method !== 'PUT' || request.headers['x-signature'] !== 'signed') {
    response.writeHead(403); response.end(); return
  }
  const [, id, number] = request.url.split('/')
  const session = sessions.get(id)
  for await (const chunk of request) session.bytes += chunk.length
  const etag = `"part-${number}"`
  session.parts.set(Number(number), etag)
  counts.puts++
  response.writeHead(200, { ETag: etag })
  response.end()
})

const page = createServer(async (request, response) => {
  const files = {
    '/': ['../tests/browser/smoke.html', 'text/html'],
    '/smoke.js': ['../tests/browser/smoke.js', 'text/javascript'],
    '/dist/index.js': ['../dist/index.js', 'text/javascript'],
  }
  const entry = files[request.url]
  if (!entry) { response.writeHead(404); response.end(); return }
  try {
    response.writeHead(200, { 'Content-Type': entry[1] })
    response.end(await readFile(new URL(entry[0], import.meta.url)))
  } catch { response.writeHead(500); response.end('Run pnpm build first') }
})

api.listen(apiPort, '127.0.0.1')
storage.listen(storagePort, '127.0.0.1')
page.listen(pagePort, '127.0.0.1', () => console.log(`Browser smoke fixture: http://localhost:${pagePort}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  api.close(); storage.close(); page.close()
})
