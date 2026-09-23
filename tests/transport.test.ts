import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putBlob, type PutOptions } from '../src/upload/transport.js'

type RuntimeListener = EventListenerOrEventListenerObject

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<RuntimeListener>>()

  addEventListener(type: string, listener: RuntimeListener | null): void {
    if (!listener) {
      return
    }

    const listeners = this.listeners.get(type) ?? new Set<RuntimeListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: RuntimeListener | null): void {
    if (!listener) {
      return
    }

    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') {
        listener(event)
      } else {
        listener.handleEvent(event)
      }
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeXMLHttpRequest extends FakeEventTarget {
  static instances: FakeXMLHttpRequest[] = []

  readonly upload = new FakeEventTarget()
  readonly headers = new Map<string, string>()
  abortCount = 0
  async = true
  body: Document | XMLHttpRequestBodyInit | null = null
  method = ''
  status = 0
  timeout = 0
  url = ''
  withCredentials = true

  private readonly responseHeaders = new Map<string, string>()

  constructor() {
    super()
    FakeXMLHttpRequest.instances.push(this)
  }

  static reset(): void {
    FakeXMLHttpRequest.instances = []
  }

  open(method: string, url: string, async = true): void {
    this.method = method
    this.url = url
    this.async = async
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  send(body: Document | XMLHttpRequestBodyInit | null = null): void {
    this.body = body
  }

  abort(): void {
    this.abortCount += 1
    this.dispatch('abort', new Event('abort'))
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null
  }

  respond(status: number, etag?: string): void {
    this.status = status
    if (etag !== undefined) {
      this.responseHeaders.set('etag', etag)
    }
    this.dispatch('load', new Event('load'))
  }

  failNetwork(): void {
    this.dispatch('error', new Event('error'))
  }

  timeOut(): void {
    this.dispatch('timeout', new Event('timeout'))
  }

  reportProgress(loaded: number): void {
    const event = { loaded } as ProgressEvent
    this.upload.dispatch('progress', event)
  }
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest

function makeOptions(overrides: Partial<PutOptions> = {}): PutOptions {
  return {
    url: 'https://uploads.example.com/signed-object',
    headers: {
      'Content-Type': 'image/png',
      'x-amz-checksum-sha256': 'checksum',
    },
    body: new Blob(['image-bytes'], { type: 'image/png' }),
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    ...overrides,
  }
}

function currentRequest(): FakeXMLHttpRequest {
  const request = FakeXMLHttpRequest.instances.at(-1)
  if (!request) {
    throw new Error('Expected an XMLHttpRequest instance')
  }
  return request
}

function expectListenersRemoved(request: FakeXMLHttpRequest): void {
  expect(request.listenerCount('load')).toBe(0)
  expect(request.listenerCount('error')).toBe(0)
  expect(request.listenerCount('abort')).toBe(0)
  expect(request.listenerCount('timeout')).toBe(0)
  expect(request.upload.listenerCount('progress')).toBe(0)
}

beforeEach(() => {
  FakeXMLHttpRequest.reset()
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: FakeXMLHttpRequest,
    writable: true,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: originalXMLHttpRequest,
    writable: true,
  })
})

describe('putBlob', () => {
  it('sends an anonymous PUT with the exact presigned headers and body', async () => {
    const options = makeOptions()
    const upload = putBlob(options)
    const request = currentRequest()

    expect(request.method).toBe('PUT')
    expect(request.url).toBe(options.url)
    expect(request.async).toBe(true)
    expect(request.withCredentials).toBe(false)
    expect(request.timeout).toBe(options.timeoutMs)
    expect(request.headers).toEqual(new Map(Object.entries(options.headers)))
    expect(request.headers.has('Authorization')).toBe(false)
    expect(request.body).toBe(options.body)

    request.respond(200, '"part-etag"')

    await expect(upload).resolves.toEqual({ etag: '"part-etag"' })
    expectListenersRemoved(request)
  })

  it('allows successful uploads without an ETag', async () => {
    const upload = putBlob(makeOptions())
    const request = currentRequest()

    request.respond(204)

    await expect(upload).resolves.toEqual({})
  })

  it('reports uploaded bytes and removes the progress listener after success', async () => {
    const onProgress = vi.fn()
    const upload = putBlob(makeOptions({ onProgress }))
    const request = currentRequest()

    request.reportProgress(4)
    request.reportProgress(11)
    request.respond(200)

    await upload
    expect(onProgress.mock.calls).toEqual([[4], [11]])
    expectListenersRemoved(request)
  })

  it('rejects non-success responses with status details', async () => {
    const upload = putBlob(makeOptions())
    const request = currentRequest()

    request.respond(403)

    await expect(upload).rejects.toMatchObject({
      kind: 'api',
      status: 403,
    })
    expectListenersRemoved(request)
  })

  it('maps network failures and cleans up listeners', async () => {
    const upload = putBlob(makeOptions())
    const request = currentRequest()

    request.failNetwork()

    await expect(upload).rejects.toMatchObject({
      kind: 'network',
    })
    expectListenersRemoved(request)
  })

  it('maps timeouts and cleans up listeners', async () => {
    const upload = putBlob(makeOptions())
    const request = currentRequest()

    request.timeOut()

    await expect(upload).rejects.toMatchObject({
      kind: 'timeout',
    })
    expectListenersRemoved(request)
  })

  it('aborts the request when its signal is cancelled', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const upload = putBlob(makeOptions({ signal: controller.signal }))
    const request = currentRequest()

    controller.abort('cancelled by caller')

    await expect(upload).rejects.toMatchObject({
      kind: 'aborted',
      cause: 'cancelled by caller',
    })
    expect(request.abortCount).toBe(1)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expectListenersRemoved(request)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(putBlob(makeOptions({ signal: controller.signal }))).rejects.toMatchObject({
      kind: 'aborted',
    })
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })

  it('aborts and rejects if a progress callback throws', async () => {
    const callbackError = new Error('progress consumer failed')
    const upload = putBlob(
      makeOptions({
        onProgress: () => {
          throw callbackError
        },
      }),
    )
    const request = currentRequest()

    request.reportProgress(2)

    await expect(upload).rejects.toBe(callbackError)
    expect(request.abortCount).toBe(1)
    expectListenersRemoved(request)
  })

  it.each(['ftp://uploads.example.com/object', 'not a url'])(
    'rejects an invalid upload URL before creating a request: %s',
    async url => {
      await expect(putBlob(makeOptions({ url }))).rejects.toMatchObject({
        kind: 'validation',
      })
      expect(FakeXMLHttpRequest.instances).toHaveLength(0)
    },
  )
})
