import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PicGoCloudClient } from '../src/client.js'
import { PicGoCloudError } from '../src/errors.js'
import type { PutOptions, PutResult } from '../src/upload/transport.js'

const { putBlobMock } = vi.hoisted(() => ({
  putBlobMock: vi.fn<(options: PutOptions) => Promise<PutResult>>(),
}))

vi.mock('../src/upload/transport.js', () => ({ putBlob: putBlobMock }))

const MIB = 1024 * 1024
const MULTIPART_THRESHOLD = 10 * MIB
const API_BASE_URL = 'https://api.example.test'
const MEDIA = { id: 'media-1', imgUrl: 'https://cdn.example.test/media-1.png' }

interface ApiCall {
  path: string
  body: unknown
  authorization: string | null
  signal?: AbortSignal | null
}

type ApiHandler = (call: ApiCall) => Response | Promise<Response>

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  storedValues(): string[] {
    return [...this.values.values()]
  }
}

function dataResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code = 'UPLOAD_FAILED'): Response {
  return new Response(JSON.stringify({ success: false, code, message: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createFetch(handler: ApiHandler): {
  calls: ApiCall[]
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
} {
  const calls: ApiCall[] = []
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    const rawBody = init?.body
    const call: ApiCall = {
      path: new URL(rawUrl).pathname,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) as unknown : undefined,
      authorization: new Headers(init?.headers).get('Authorization'),
      signal: init?.signal,
    }
    calls.push(call)
    return handler(call)
  })
  return { calls, fetchMock }
}

function imageFile(size: number, name = 'photo.png'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

function signedPart(partNumber: number, prefix = 'initial') {
  return {
    partNumber,
    url: `https://uploads.example.test/${prefix}/part-${partNumber}`,
    method: 'PUT' as const,
    headers: { 'x-picgo-part': `${prefix}-${partNumber}` },
  }
}

function multipartSession(fileSize: number, partSize: number, prefix = 'initial') {
  const partCount = Math.ceil(fileSize / partSize)
  return {
    uploadId: 'upload-1',
    objectKey: 'objects/photo.png',
    publicId: 'public-1',
    partSize,
    partCount,
    parts: Array.from({ length: partCount }, (_, index) => signedPart(index + 1, prefix)),
  }
}

function unexpected(call: ApiCall): never {
  throw new Error(`Unexpected API request: ${call.path}`)
}

function requestBody<T>(call: ApiCall): T {
  return call.body as T
}

function uploadCalls(): PutOptions[] {
  return putBlobMock.mock.calls.map(([options]) => options)
}

beforeEach(() => {
  putBlobMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PicGoCloud uploads', () => {
  it('switches at 10 MiB, preserves presign headers, and uses server part sizes and ETags', async () => {
    const largeFile = imageFile(MULTIPART_THRESHOLD, 'large.png')
    const smallFile = imageFile(1024, 'small.png')
    const session = multipartSession(largeFile.size, 3 * MIB)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/presign':
          return dataResponse({
            objectKey: 'objects/small.png',
            publicId: 'small-public',
            uploadUrl: 'https://uploads.example.test/single',
            method: 'PUT',
            headers: { 'Content-Type': 'image/custom', 'x-presigned': 'keep-me' },
          })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/complete':
          return dataResponse({ completed: true })
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(async options => {
      const match = /part-(\d+)$/.exec(options.url)
      return match ? { etag: `etag-${match[1]}` } : {}
    })
    const client = new PicGoCloudClient({ token: 'user-token', baseUrl: API_BASE_URL, fetch: fetchMock })

    await expect(client.upload(smallFile)).resolves.toEqual(MEDIA)
    await expect(client.upload(largeFile, { concurrency: 1 })).resolves.toEqual(MEDIA)

    expect(calls.filter(call => call.path === '/api/upload/presign')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/api/upload/multipart/initiate')).toHaveLength(1)
    expect(uploadCalls()[0]?.headers).toEqual({
      'Content-Type': 'image/custom',
      'x-presigned': 'keep-me',
    })
    expect(uploadCalls().slice(1).map(call => call.body.size)).toEqual([3 * MIB, 3 * MIB, 3 * MIB, MIB])

    const merge = calls.find(call => call.path === '/api/upload/multipart/complete')
    expect(merge).toBeDefined()
    expect(requestBody<{ parts: Array<{ partNumber: number; etag: string }> }>(merge!).parts).toEqual([
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
      { partNumber: 4, etag: 'etag-4' },
    ])
  })

  it('resumes the same file for the same user, skips completed parts, and never persists either token', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, 4 * MIB)
    let initiateCount = 0
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'stable-user' })
        case '/api/upload/multipart/initiate':
          initiateCount += 1
          return dataResponse(session)
        case '/api/upload/multipart/part-urls': {
          const body = requestBody<{ partNumbers: number[] }>(call)
          return dataResponse({ parts: body.partNumbers.map(number => signedPart(number, 'refreshed')) })
        }
        case '/api/upload/multipart/complete':
          return dataResponse({ completed: true })
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(async options => {
      if (options.url.endsWith('part-1')) {
        return { etag: 'etag-1' }
      }
      throw new PicGoCloudError('part rejected', { kind: 'upload' })
    })
    const firstClient = new PicGoCloudClient({
      token: 'secret-token-a',
      baseUrl: API_BASE_URL,
      fetch: fetchMock,
      storage,
    })

    await expect(firstClient.upload(file, { concurrency: 1 })).rejects.toMatchObject({ kind: 'upload' })
    expect(storage.length).toBe(1)
    const persisted = storage.storedValues().join('\n')
    expect(persisted).not.toContain('secret-token-a')
    expect(persisted).not.toContain('secret-token-b')
    expect(persisted).toContain('"partNumber":1')

    putBlobMock.mockReset()
    putBlobMock.mockImplementation(async options => {
      const match = /part-(\d+)$/.exec(options.url)
      return { etag: `etag-${match?.[1] ?? 'missing'}` }
    })
    const secondClient = new PicGoCloudClient({
      token: 'secret-token-b',
      baseUrl: API_BASE_URL,
      fetch: fetchMock,
      storage,
    })

    await expect(secondClient.upload(file, { concurrency: 1 })).resolves.toEqual(MEDIA)
    expect(initiateCount).toBe(1)
    expect(uploadCalls().map(call => call.url)).toEqual([
      'https://uploads.example.test/refreshed/part-2',
      'https://uploads.example.test/refreshed/part-3',
    ])
    expect(calls.filter(call => call.path === '/api/whoami').map(call => call.authorization)).toEqual([
      'Bearer secret-token-a',
      'Bearer secret-token-b',
    ])
    expect(storage.length).toBe(0)
  })

  it('keeps a paused multipart session but aborts and removes it on cancel', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, 5 * MIB)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/abort':
          return dataResponse({ aborted: true })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(options => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const task = client.createUpload(file, { concurrency: 1 })

    const running = task.start()
    await vi.waitFor(() => expect(putBlobMock).toHaveBeenCalledTimes(1))
    task.pause()

    await expect(running).rejects.toMatchObject({ kind: 'paused' })
    expect(task.status).toBe('paused')
    expect(storage.length).toBe(1)
    expect(calls.some(call => call.path === '/api/upload/multipart/abort')).toBe(false)

    await task.cancel()

    expect(task.status).toBe('cancelled')
    expect(calls.filter(call => call.path === '/api/upload/multipart/abort')).toHaveLength(1)
    expect(storage.length).toBe(0)
  })

  it('retains an uploaded state after registration failure and retries without uploading or merging again', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    let registrationAttempts = 0
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/complete':
          return dataResponse({ completed: true })
        case '/api/album-items/complete':
          registrationAttempts += 1
          return registrationAttempts === 1 ? errorResponse(422, 'REGISTRATION_REJECTED') : dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockResolvedValue({ etag: 'etag-1' })
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const task = client.createUpload(file)

    await expect(task.start()).rejects.toMatchObject({ status: 422, code: 'REGISTRATION_REJECTED' })
    expect(storage.storedValues().join('')).toContain('"phase":"uploaded"')
    expect(putBlobMock).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.path === '/api/upload/multipart/complete')).toHaveLength(1)

    await expect(task.start()).resolves.toEqual(MEDIA)
    expect(putBlobMock).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.path === '/api/upload/multipart/complete')).toHaveLength(1)
    expect(registrationAttempts).toBe(2)
    expect(storage.length).toBe(0)
  })

  it('recovers a lost merge response by probing media registration instead of merging again', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const session = multipartSession(file.size, file.size)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/complete':
          throw new TypeError('connection dropped after merge')
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockResolvedValue({ etag: 'etag-1' })
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock })

    await expect(client.upload(file)).resolves.toEqual(MEDIA)
    expect(calls.filter(call => call.path === '/api/upload/multipart/complete')).toHaveLength(1)
    expect(calls.filter(call => call.path === '/api/album-items/complete')).toHaveLength(1)
  })

  it('aborts sibling multipart workers when one part fails permanently', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const session = multipartSession(file.size, 5 * MIB)
    const siblingSignals: AbortSignal[] = []
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(options => {
      if (options.url.endsWith('part-1')) {
        return Promise.reject(new PicGoCloudError('permanent part failure', { kind: 'upload' }))
      }
      siblingSignals.push(options.signal)
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason)
          return
        }
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    })
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock })

    await expect(client.upload(file, { concurrency: 2 })).rejects.toMatchObject({
      kind: 'upload',
      message: 'permanent part failure',
    })
    expect(siblingSignals).toHaveLength(1)
    expect(siblingSignals[0]?.aborted).toBe(true)
    expect(calls.some(call => call.path === '/api/upload/multipart/complete')).toBe(false)
  })

  it('gets a fresh single-upload URL and retries after a 403', async () => {
    vi.useFakeTimers()
    const file = imageFile(1024)
    let presignCount = 0
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/presign':
          presignCount += 1
          return dataResponse({
            objectKey: `objects/photo-${presignCount}.png`,
            publicId: `public-${presignCount}`,
            uploadUrl: `https://uploads.example.test/single-${presignCount}`,
            method: 'PUT',
            headers: { 'x-signature': `signature-${presignCount}` },
          })
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock
      .mockRejectedValueOnce(new PicGoCloudError('signature expired', { kind: 'api', status: 403 }))
      .mockResolvedValueOnce({})
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock })

    const upload = client.upload(file)
    await vi.advanceTimersByTimeAsync(0)
    expect(presignCount).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)

    await expect(upload).resolves.toEqual(MEDIA)
    expect(uploadCalls().map(call => call.url)).toEqual([
      'https://uploads.example.test/single-1',
      'https://uploads.example.test/single-2',
    ])
    const registration = calls.find(call => call.path === '/api/album-items/complete')
    expect(requestBody<{ objectKey: string; publicId: string }>(registration!)).toMatchObject({
      objectKey: 'objects/photo-2.png',
      publicId: 'public-2',
    })
  })

  it('rejects multipart uploads when the PUT response does not expose an ETag', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const session = multipartSession(file.size, file.size)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockResolvedValue({})
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock })

    await expect(client.upload(file)).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('ETag'),
    })
    expect(calls.some(call => call.path === '/api/upload/multipart/complete')).toBe(false)
  })

  it('resolves localhost upload paths and only adds bearer auth for exact local proxy routes', async () => {
    const localBaseUrl = 'http://localhost:8787'
    const targets = [
      '/api/upload/put/object-1',
      '/api/upload/putevil/object-2',
      'https://r2.example.test/object-3',
    ]
    let presignCount = 0
    const { fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/presign': {
          const index = presignCount++
          return dataResponse({
            objectKey: `objects/photo-${index}.png`,
            publicId: `public-${index}`,
            uploadUrl: targets[index],
            method: 'PUT',
            headers: { 'x-presigned': `signature-${index}` },
          })
        }
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockResolvedValue({})
    const client = new PicGoCloudClient({ token: 'local-user-token', baseUrl: localBaseUrl, fetch: fetchMock })

    await client.upload(imageFile(128, 'first.png'))
    await client.upload(imageFile(128, 'second.png'))
    await client.upload(imageFile(128, 'third.png'))

    expect(uploadCalls().map(call => ({ url: call.url, headers: call.headers }))).toEqual([
      {
        url: 'http://localhost:8787/api/upload/put/object-1',
        headers: {
          'x-presigned': 'signature-0',
          'Content-Type': 'image/png',
          Authorization: 'Bearer local-user-token',
        },
      },
      {
        url: 'http://localhost:8787/api/upload/putevil/object-2',
        headers: { 'x-presigned': 'signature-1', 'Content-Type': 'image/png' },
      },
      {
        url: 'https://r2.example.test/object-3',
        headers: { 'x-presigned': 'signature-2', 'Content-Type': 'image/png' },
      },
    ])
  })

  it('clears an uploaded session after registration returns 404 so the next start uploads afresh', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    let registrationAttempts = 0
    let initiationAttempts = 0
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          initiationAttempts += 1
          return dataResponse({ ...session, uploadId: `upload-${initiationAttempts}` })
        case '/api/upload/multipart/complete':
          return dataResponse({ completed: true })
        case '/api/album-items/complete':
          registrationAttempts += 1
          return registrationAttempts === 1 ? errorResponse(404, 'OBJECT_NOT_FOUND') : dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(async () => ({ etag: `etag-${putBlobMock.mock.calls.length}` }))
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const task = client.createUpload(file)

    await expect(task.start()).rejects.toMatchObject({ status: 404 })
    expect(storage.length).toBe(0)

    await expect(task.start()).resolves.toEqual(MEDIA)
    expect(initiationAttempts).toBe(2)
    expect(putBlobMock).toHaveBeenCalledTimes(2)
    expect(calls.filter(call => call.path === '/api/upload/multipart/complete')).toHaveLength(2)
  })

  it('aborts and clears a multipart session when the backend reports a part mismatch', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/complete':
          return errorResponse(409, 'MULTIPART_PART_MISMATCH')
        case '/api/upload/multipart/abort':
          return dataResponse({ aborted: true })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockResolvedValue({ etag: 'etag-1' })
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })

    await expect(client.upload(file)).rejects.toMatchObject({
      status: 409,
      code: 'MULTIPART_PART_MISMATCH',
    })
    expect(calls.filter(call => call.path === '/api/upload/multipart/abort')).toHaveLength(1)
    expect(storage.length).toBe(0)
  })

  it('uses the original account token to cancel after a restarted task detects an account change', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    const tokenProvider = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('token-a')
      .mockResolvedValueOnce('token-b')
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: call.authorization === 'Bearer token-a' ? 'user-a' : 'user-b' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/abort':
          return dataResponse({ aborted: true })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(options => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const client = new PicGoCloudClient({ token: tokenProvider, baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const task = client.createUpload(file)

    const firstStart = task.start()
    await vi.waitFor(() => expect(putBlobMock).toHaveBeenCalledTimes(1))
    task.pause()
    await expect(firstStart).rejects.toMatchObject({ kind: 'paused' })

    await expect(task.start()).rejects.toMatchObject({
      kind: 'validation',
      message: expect.stringContaining('account changed'),
    })
    await task.cancel()

    const abortCall = calls.find(call => call.path === '/api/upload/multipart/abort')
    expect(abortCall?.authorization).toBe('Bearer token-a')
    expect(storage.length).toBe(0)
  })

  it('does not delete another cached session when a resume:false upload succeeds', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    let initiationAttempts = 0
    const { fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate': {
          initiationAttempts += 1
          const prefix = initiationAttempts === 1 ? 'cached' : 'independent'
          return dataResponse({
            ...multipartSession(file.size, 5 * MIB, prefix),
            uploadId: `${prefix}-upload`,
            objectKey: `objects/${prefix}.png`,
            publicId: `${prefix}-public`,
          })
        }
        case '/api/upload/multipart/complete':
          return dataResponse({ completed: true })
        case '/api/album-items/complete':
          return dataResponse({ item: MEDIA })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(async options => {
      if (options.url.includes('/cached/part-1')) {
        return { etag: 'cached-etag-1' }
      }
      throw new PicGoCloudError('leave the first session resumable', { kind: 'upload' })
    })
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })

    await expect(client.upload(file, { concurrency: 1 })).rejects.toMatchObject({ kind: 'upload' })
    const cachedKey = storage.key(0)
    const cachedValue = cachedKey ? storage.getItem(cachedKey) : null
    expect(cachedValue).toContain('cached-upload')

    putBlobMock.mockReset()
    putBlobMock.mockImplementation(async options => {
      const partNumber = /part-(\d+)$/.exec(options.url)?.[1]
      return { etag: `independent-etag-${partNumber}` }
    })

    await expect(client.upload(file, { concurrency: 1, resume: false })).resolves.toEqual(MEDIA)
    expect(initiationAttempts).toBe(2)
    expect(storage.length).toBe(1)
    expect(cachedKey && storage.getItem(cachedKey)).toBe(cachedValue)
  })

  it('does not remove the active owner session when a duplicate task fails to acquire its lock', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/abort':
          return dataResponse({ aborted: true })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(options => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const owner = client.createUpload(file)
    const duplicate = client.createUpload(file)

    const ownerRunning = owner.start()
    await vi.waitFor(() => expect(putBlobMock).toHaveBeenCalledTimes(1))
    const cachedKey = storage.key(0)
    const cachedValue = cachedKey ? storage.getItem(cachedKey) : null

    await expect(duplicate.start()).rejects.toMatchObject({
      kind: 'validation',
    })
    await duplicate.cancel()

    expect(storage.length).toBe(1)
    expect(cachedKey && storage.getItem(cachedKey)).toBe(cachedValue)
    expect(calls.some(call => call.path === '/api/upload/multipart/abort')).toBe(false)

    await owner.cancel()
    await expect(ownerRunning).rejects.toMatchObject({ kind: 'aborted' })
    expect(calls.filter(call => call.path === '/api/upload/multipart/abort')).toHaveLength(1)
    expect(storage.length).toBe(0)
  })

  it('refuses to cancel a paused task while another task actively resumes its session', async () => {
    const file = imageFile(MULTIPART_THRESHOLD)
    const storage = new MemoryStorage()
    const session = multipartSession(file.size, file.size)
    const { calls, fetchMock } = createFetch(call => {
      switch (call.path) {
        case '/api/whoami':
          return dataResponse({ userId: 'user-1' })
        case '/api/upload/multipart/initiate':
          return dataResponse(session)
        case '/api/upload/multipart/part-urls':
          return dataResponse({ parts: [signedPart(1, 'resumed')] })
        case '/api/upload/multipart/abort':
          return dataResponse({ aborted: true })
        default:
          return unexpected(call)
      }
    })
    putBlobMock.mockImplementation(options => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const client = new PicGoCloudClient({ token: 'token', baseUrl: API_BASE_URL, fetch: fetchMock, storage })
    const pausedTask = client.createUpload(file)

    const firstRun = pausedTask.start()
    await vi.waitFor(() => expect(putBlobMock).toHaveBeenCalledTimes(1))
    pausedTask.pause()
    await expect(firstRun).rejects.toMatchObject({ kind: 'paused' })

    const resumedTask = client.createUpload(file)
    const resumedRun = resumedTask.start()
    await vi.waitFor(() => expect(putBlobMock).toHaveBeenCalledTimes(2))
    const cachedKey = storage.key(0)
    const cachedValue = cachedKey ? storage.getItem(cachedKey) : null

    await expect(pausedTask.cancel()).rejects.toMatchObject({
      kind: 'validation',
    })
    expect(storage.length).toBe(1)
    expect(cachedKey && storage.getItem(cachedKey)).toBe(cachedValue)
    expect(calls.some(call => call.path === '/api/upload/multipart/abort')).toBe(false)

    await resumedTask.cancel()
    await expect(resumedRun).rejects.toMatchObject({ kind: 'aborted' })
    expect(calls.filter(call => call.path === '/api/upload/multipart/abort')).toHaveLength(1)
    expect(storage.length).toBe(0)
  })
})
