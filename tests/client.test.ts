import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpClient } from '../src/http.js'
import { MediaService } from '../src/media.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchMock.mock.calls[index]
  if (!call) {
    throw new Error(`Missing fetch call ${index}`)
  }
  return call
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HttpClient', () => {
  it('normalizes the base URL, adds bearer auth, and unwraps data envelopes', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { value: 42 } }))
    const client = new HttpClient({
      token: async () => 'user-token',
      baseUrl: 'https://cloud.example.test/',
      fetch: fetchMock,
    })

    await expect(client.request<{ value: number }>('/api/example')).resolves.toEqual({ value: 42 })
    expect(client.baseUrl).toBe('https://cloud.example.test')

    const [url, init] = getFetchCall(fetchMock, 0)
    expect(url).toBe('https://cloud.example.test/api/example')
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
    })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer user-token')
  })

  it('keeps top-level API fields while removing a successful envelope flag', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, uploadUrl: 'https://upload.test' }))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await expect(client.request<{ uploadUrl: string }>('/api/presign')).resolves.toEqual({
      uploadUrl: 'https://upload.test',
    })
  })

  it('creates a fixed-token client for multi-request operations', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const tokenProvider = vi.fn(async () => 'snapshot-token')
    const client = new HttpClient({ token: tokenProvider, fetch: fetchMock })
    const token = await client.resolveToken()

    await client.withToken(token).request('/api/example')

    expect(tokenProvider).toHaveBeenCalledTimes(1)
    const [, init] = getFetchCall(fetchMock, 0)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer snapshot-token')
  })

  it('serializes JSON request bodies', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { updated: true } }))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await client.request('/api/example', { method: 'PATCH', body: { name: 'new name' } })

    const [, init] = getFetchCall(fetchMock, 0)
    expect(init?.body).toBe('{"name":"new name"}')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
  })

  it('exposes backend status and error code without branching on the message', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { success: false, code: 'UNAUTHORIZED', message: 'Token expired' },
      { status: 401 },
    ))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await expect(client.request('/api/example')).rejects.toMatchObject({
      name: 'PicGoCloudError',
      kind: 'api',
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Token expired',
    })
  })

  it('rejects success:false even when the HTTP status is successful', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: false,
      code: 'INVALID_REQUEST',
      message: 'Invalid request',
    }))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await expect(client.request('/api/example')).rejects.toMatchObject({
      kind: 'api',
      status: 200,
      code: 'INVALID_REQUEST',
    })
  })

  it('reports malformed JSON as a protocol error', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(new Response('{broken', { status: 200 }))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await expect(client.request('/api/example')).rejects.toMatchObject({
      kind: 'protocol',
      status: 200,
    })
  })

  it('reports fetch failures as network errors', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const client = new HttpClient({ token: 'token', fetch: fetchMock })

    await expect(client.request('/api/example')).rejects.toMatchObject({ kind: 'network' })
  })

  it('times out while an async token is still resolving', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    const unresolvedToken = new Promise<string>(() => undefined)
    const client = new HttpClient({
      token: () => unresolvedToken,
      fetch: fetchMock,
      timeoutMs: 50,
    })

    const request = client.request('/api/example')
    const assertion = expect(request).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('applies the configured timeout to standalone token resolution', async () => {
    vi.useFakeTimers()
    const unresolvedToken = new Promise<string>(() => undefined)
    const client = new HttpClient({
      token: () => unresolvedToken,
      fetch: vi.fn<typeof fetch>(),
      timeoutMs: 50,
    })

    const resolution = client.resolveToken()
    const assertion = expect(resolution).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it('does not invoke the token provider for a pre-aborted signal', async () => {
    const tokenProvider = vi.fn(async () => 'token')
    const client = new HttpClient({ token: tokenProvider, fetch: vi.fn<typeof fetch>() })
    const controller = new AbortController()
    controller.abort()

    await expect(client.resolveToken(controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(tokenProvider).not.toHaveBeenCalled()
  })

  it('observes a rejecting provider promise when token resolution is aborted synchronously', async () => {
    const controller = new AbortController()
    const tokenProvider = vi.fn(() => {
      controller.abort()
      return Promise.reject(new Error('provider rejected'))
    })
    const client = new HttpClient({ token: tokenProvider, fetch: vi.fn<typeof fetch>() })

    await expect(client.resolveToken(controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(tokenProvider).toHaveBeenCalledTimes(1)
  })

  it('validates the runtime token value before using string methods', async () => {
    const invalidProvider = (() => 123) as unknown as () => string
    const client = new HttpClient({ token: invalidProvider, fetch: vi.fn<typeof fetch>() })

    await expect(client.resolveToken()).rejects.toMatchObject({ kind: 'validation' })
  })

  it('can abort while an async token is still resolving', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const unresolvedToken = new Promise<string>(() => undefined)
    const client = new HttpClient({ token: () => unresolvedToken, fetch: fetchMock })
    const controller = new AbortController()

    const request = client.request('/api/example', { signal: controller.signal })
    controller.abort()

    await expect(request).rejects.toMatchObject({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects cross-origin paths before resolving or sending the token', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const tokenProvider = vi.fn(async () => 'token')
    const client = new HttpClient({ token: tokenProvider, fetch: fetchMock })

    await expect(client.request('https://attacker.test/steal')).rejects.toMatchObject({
      kind: 'validation',
    })
    expect(tokenProvider).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('MediaService', () => {
  it('maps media operations to album-item endpoints and request bodies', async () => {
    const mediaItem = { id: 'media-id', imgUrl: 'https://img.test/a.png' }
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { items: [mediaItem], limit: 10, offset: 0, total: 1 },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { item: mediaItem } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { item: mediaItem } }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { updated: 1, skipped: 0, items: [mediaItem] },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { message: 'Deleted' } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: 1 } }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { contentTypes: ['image/png'], types: ['picgo-cloud'], exts: ['.png'] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { total: 1, types: [{ type: 'picgo-cloud', count: 1 }] },
      }))

    const service = new MediaService(new HttpClient({
      token: 'token',
      baseUrl: 'https://cloud.example.test',
      fetch: fetchMock,
    }))

    await expect(service.list({
      limit: 10,
      offset: 0,
      search: 'cat photo',
      contentType: 'image/png',
      ext: '.png',
      fileName: 'cat',
      type: 'picgo-cloud',
      sort: 'fileName',
      order: 'asc',
    })).resolves.toMatchObject({ total: 1 })
    await expect(service.get('media/id')).resolves.toEqual(mediaItem)
    await expect(service.update('media/id', { fileName: 'renamed.png' })).resolves.toEqual(mediaItem)
    await expect(service.updateMany([{ id: 'media-id', fileName: 'renamed.png' }])).resolves.toMatchObject({
      updated: 1,
    })
    await expect(service.delete('media/id')).resolves.toEqual({ message: 'Deleted' })
    await expect(service.deleteMany(['media-id'])).resolves.toEqual({ deleted: 1 })
    await expect(service.filters()).resolves.toMatchObject({ types: ['picgo-cloud'] })
    await expect(service.stats()).resolves.toMatchObject({ total: 1 })

    expect(getFetchCall(fetchMock, 0)[0]).toBe(
      'https://cloud.example.test/api/album-items?limit=10&offset=0&search=cat+photo&contentType=image%2Fpng&ext=.png&fileName=cat&type=picgo-cloud&sort=fileName&order=asc',
    )
    expect(getFetchCall(fetchMock, 1)[0]).toBe('https://cloud.example.test/api/album-items/media%2Fid')
    expect(getFetchCall(fetchMock, 2)[1]).toMatchObject({
      method: 'PATCH',
      body: '{"fileName":"renamed.png"}',
    })
    expect(getFetchCall(fetchMock, 3)[1]).toMatchObject({
      method: 'PATCH',
      body: '{"items":[{"id":"media-id","fileName":"renamed.png"}]}',
    })
    expect(getFetchCall(fetchMock, 4)[1]).toMatchObject({ method: 'DELETE' })
    expect(getFetchCall(fetchMock, 5)[1]).toMatchObject({
      method: 'DELETE',
      body: '{"ids":["media-id"]}',
    })
    expect(getFetchCall(fetchMock, 6)[0]).toBe('https://cloud.example.test/api/album-items/filters')
    expect(getFetchCall(fetchMock, 7)[0]).toBe('https://cloud.example.test/api/album-items/stats')
  })

  it('rejects invalid pagination before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const service = new MediaService(new HttpClient({ token: 'token', fetch: fetchMock }))

    await expect(service.list({ limit: 0 })).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.list({ limit: 101 })).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.list({ offset: -1 })).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.list({ offset: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
      kind: 'validation',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects empty and reserved media ids before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const service = new MediaService(new HttpClient({ token: 'token', fetch: fetchMock }))

    await expect(service.get('  ')).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.update('filters', {})).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.delete('stats')).rejects.toMatchObject({ kind: 'validation' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces Worker batch bounds and validates every batch id', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const service = new MediaService(new HttpClient({ token: 'token', fetch: fetchMock }))
    const tooManyIds = Array.from({ length: 101 }, (_, index) => `media-${index}`)

    await expect(service.updateMany([])).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.updateMany([{ id: '', fileName: 'name.png' }])).rejects.toMatchObject({
      kind: 'validation',
    })
    const malformedUpdates = [null] as unknown as Parameters<typeof service.updateMany>[0]
    await expect(service.updateMany(malformedUpdates)).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.deleteMany([])).rejects.toMatchObject({ kind: 'validation' })
    await expect(service.deleteMany(tooManyIds)).rejects.toMatchObject({ kind: 'validation' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
