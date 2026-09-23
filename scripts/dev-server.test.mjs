import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createDevServer, readDevConfig } from './dev-server.mjs'

test('development config uses only the API URL and local port', () => {
  assert.deepEqual(readDevConfig({ PICGO_API_URL: 'https://preview.example.com/', PICGO_DEV_PORT: '5176', SECRET: 'private' }), {
    apiUrl: 'https://preview.example.com', port: 5176,
  })
  assert.equal(readDevConfig({}).apiUrl, 'https://api.picgo.app')
  for (const value of ['file:///tmp/file', 'https://user:secret@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => readDevConfig({ PICGO_API_URL: value }))
  }
  assert.throws(() => readDevConfig({ PICGO_DEV_PORT: '0' }))
})

test('development server exposes config and examples, never env files or a backend proxy', async () => {
  const server = createDevServer({ apiUrl: 'https://preview.example.com', secret: 'private' })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const config = await fetch(`${base}/config.json`)
    assert.deepEqual(await config.json(), { apiUrl: 'https://preview.example.com' })
    assert.equal(config.headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(base)).status, 200)
    for (const path of ['/.env', '/.env.example', '/package.json', '/src/client.ts', '/api/whoami', '/%2eenv']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404)
    }
    assert.equal((await fetch(`${base}/config.json`, { method: 'POST' })).status, 405)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
