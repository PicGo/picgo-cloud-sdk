import { PicGoCloudError, isPicGoCloudError } from './errors.js'
import type { TokenProvider } from './types.js'

const DEFAULT_BASE_URL = 'https://api.picgo.app'
const DEFAULT_TIMEOUT_MS = 30_000

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HttpClientConfig {
  token: TokenProvider
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface HttpRequestOptions {
  method?: HttpMethod
  body?: unknown
  signal?: AbortSignal
}

type ApiEnvelope = {
  success?: unknown
  data?: unknown
  code?: unknown
  message?: unknown
} & Record<string, unknown>

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new PicGoCloudError('Invalid PicGo Cloud API base URL', {
      kind: 'validation',
      cause,
    })
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PicGoCloudError('PicGo Cloud API base URL must use HTTP or HTTPS', {
      kind: 'validation',
    })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PicGoCloudError('PicGo Cloud API base URL cannot contain credentials, a query, or a hash', {
      kind: 'validation',
    })
  }

  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getApiMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message
  }
  return fallback
}

function getApiCode(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.code === 'string') {
    return payload.code
  }
  return undefined
}

function abortedError(signal: AbortSignal): PicGoCloudError {
  if (isPicGoCloudError(signal.reason)) {
    return signal.reason
  }
  return new PicGoCloudError('The request was aborted', {
    kind: 'aborted',
    cause: signal.reason,
  })
}

async function awaitWithAbort<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return value
  }

  return await new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(abortedError(signal))
    }

    value.then(
      (result) => {
        signal.removeEventListener('abort', handleAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort)
        reject(error)
      },
    )
    if (signal.aborted) {
      handleAbort()
    } else {
      signal.addEventListener('abort', handleAbort, { once: true })
    }
  })
}

export class HttpClient {
  readonly baseUrl: string

  private readonly tokenProvider: TokenProvider
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly baseOrigin: string

  constructor(config: HttpClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)
    this.baseOrigin = new URL(this.baseUrl).origin
    this.tokenProvider = config.token
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PicGoCloudError('timeoutMs must be a positive number', { kind: 'validation' })
    }

    const fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new PicGoCloudError('This browser does not provide fetch', { kind: 'validation' })
    }
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  async resolveToken(signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    let timedOut = false
    const handleAbort = (): void => {
      controller.abort(signal?.reason)
    }
    if (signal?.aborted) {
      handleAbort()
    } else {
      signal?.addEventListener('abort', handleAbort, { once: true })
    }
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      return await this.resolveTokenWithSignal(controller.signal)
    } catch (cause) {
      if (timedOut) {
        throw new PicGoCloudError(`PicGo Cloud token resolution timed out after ${this.timeoutMs}ms`, {
          kind: 'timeout',
          cause,
        })
      }
      if (controller.signal.aborted) {
        throw abortedError(controller.signal)
      }
      throw cause
    } finally {
      globalThis.clearTimeout(timeoutId)
      signal?.removeEventListener('abort', handleAbort)
    }
  }

  private async resolveTokenWithSignal(signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      throw abortedError(signal)
    }

    let tokenPromise: Promise<unknown>
    try {
      tokenPromise = typeof this.tokenProvider === 'function'
        ? Promise.resolve(this.tokenProvider())
        : Promise.resolve(this.tokenProvider)
    } catch (cause) {
      throw new PicGoCloudError('Failed to resolve the PicGo Cloud token', {
        kind: 'authentication',
        cause,
      })
    }

    let token: unknown
    try {
      token = await awaitWithAbort(tokenPromise, signal)
    } catch (cause) {
      if (isPicGoCloudError(cause)) {
        throw cause
      }
      throw new PicGoCloudError('Failed to resolve the PicGo Cloud token', {
        kind: 'authentication',
        cause,
      })
    }

    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new PicGoCloudError('PicGo Cloud token must be a non-empty string', {
        kind: 'validation',
      })
    }
    return token.trim()
  }

  withToken(token: string): HttpClient {
    return new HttpClient({
      token,
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })
  }

  async request<T>(path: string, options: HttpRequestOptions = {}): Promise<T> {
    if (!path.startsWith('/')) {
      throw new PicGoCloudError('API request paths must start with /', { kind: 'validation' })
    }

    const url = new URL(`${this.baseUrl}${path}`)
    if (url.origin !== this.baseOrigin) {
      throw new PicGoCloudError('Refusing to send a PicGo Cloud token to another origin', {
        kind: 'validation',
      })
    }

    const controller = new AbortController()
    let timedOut = false
    const handleAbort = (): void => {
      controller.abort(options.signal?.reason)
    }
    if (options.signal?.aborted) {
      handleAbort()
    } else {
      options.signal?.addEventListener('abort', handleAbort, { once: true })
    }
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const token = await this.resolveTokenWithSignal(controller.signal)
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      }
      let body: string | undefined
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        try {
          body = JSON.stringify(options.body)
        } catch (cause) {
          throw new PicGoCloudError('Request body is not JSON serializable', {
            kind: 'validation',
            cause,
          })
        }
        if (body === undefined) {
          throw new PicGoCloudError('Request body is not JSON serializable', {
            kind: 'validation',
          })
        }
      }

      const response = await this.fetchImpl(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })

      if (response.status === 204) {
        if (!response.ok) {
          throw new PicGoCloudError(`PicGo Cloud API request failed with status ${response.status}`, {
            kind: 'api',
            status: response.status,
          })
        }
        return undefined as T
      }

      const responseText = await response.text()
      let payload: unknown
      if (responseText.length === 0) {
        if (!response.ok) {
          throw new PicGoCloudError(
            response.statusText || `PicGo Cloud API request failed with status ${response.status}`,
            { kind: 'api', status: response.status },
          )
        }
        throw new PicGoCloudError('PicGo Cloud API returned an empty response', {
          kind: 'protocol',
          status: response.status,
        })
      }
      try {
        payload = JSON.parse(responseText) as unknown
      } catch (cause) {
        throw new PicGoCloudError('PicGo Cloud API returned malformed JSON', {
          kind: 'protocol',
          status: response.status,
          cause,
        })
      }

      const envelope: ApiEnvelope | undefined = isRecord(payload) ? payload : undefined
      if (envelope?.success === false || !response.ok) {
        throw new PicGoCloudError(
          getApiMessage(payload, response.statusText || `PicGo Cloud API request failed with status ${response.status}`),
          {
            kind: 'api',
            status: response.status,
            code: getApiCode(payload),
          },
        )
      }

      if (envelope?.success === true) {
        if (Object.hasOwn(envelope, 'data')) {
          return envelope.data as T
        }
        const result: Record<string, unknown> = { ...envelope }
        delete result.success
        return result as T
      }
      return payload as T
    } catch (cause) {
      if (timedOut) {
        throw new PicGoCloudError(`PicGo Cloud API request timed out after ${this.timeoutMs}ms`, {
          kind: 'timeout',
          cause,
        })
      }
      if (controller.signal.aborted) {
        throw abortedError(controller.signal)
      }
      if (isPicGoCloudError(cause)) {
        throw cause
      }
      throw new PicGoCloudError('Could not reach the PicGo Cloud API', {
        kind: 'network',
        cause,
      })
    } finally {
      globalThis.clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', handleAbort)
    }
  }
}
