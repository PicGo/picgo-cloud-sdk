import { PicGoCloudError } from '../errors.js'
import { ApiErrorCode } from '../api-error-codes.js'
import type { HttpClient } from '../http.js'
import type { MediaItem } from '../types.js'
import { normalizeMediaItem } from '../media-item.js'
import type { MediaItemResponse } from '../media-item.js'
import { digest, fingerprint, ResumeStore, throwIfAborted, withUploadLock } from './storage.js'
import { putBlob } from './transport.js'
import type { MultipartSession, PresignResult, SignedPart, StoredUpload, UploadConfig, UploadOptions, UploadPhase, UploadStatus } from './types.js'

const MULTIPART_THRESHOLD = 10 * 1024 * 1024
const MAX_SIZE = 1024 * 1024 * 1024
const BACKOFF = [1000, 2000, 4000]

function isRetryable(error: unknown): boolean {
  return error instanceof PicGoCloudError && (error.kind === 'network' || error.kind === 'timeout'
    || error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function retry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal)
    try { return await run() } catch (error) {
      const wait = BACKOFF[attempt]
      if (!isRetryable(error) || wait === undefined) throw error
      await delay(wait, signal)
    }
  }
}

function protocol(message: string): never {
  throw new PicGoCloudError(message, { kind: 'protocol' })
}

function validateSession(data: MultipartSession, size: number): void {
  if (!data || typeof data.uploadId !== 'string' || !data.uploadId
    || typeof data.objectKey !== 'string' || !data.objectKey || typeof data.publicId !== 'string' || !data.publicId
    || !Number.isSafeInteger(data.partSize) || data.partSize <= 0
    || data.partCount < 1 || data.partCount > 10_000
    || data.partCount !== Math.ceil(size / data.partSize) || !Array.isArray(data.parts)) {
    protocol('Invalid multipart session response')
  }
}

/** A lazy upload. start() resolves only after the media item has been registered. */
export class UploadTask {
  private currentStatus: UploadStatus = 'idle'
  private controller?: AbortController
  private running?: Promise<MediaItem>
  private result?: MediaItem
  private state?: StoredUpload
  private sessionHttp?: HttpClient
  private uploadToken?: string
  private owner?: string
  private key?: string
  private resumed = false
  private cancelling = false
  private readonly store: ResumeStore
  private readonly filename: string
  private readonly contentType: string
  private readonly concurrency: number
  private readonly timeoutMs: number

  constructor(
    private readonly http: HttpClient,
    private readonly file: Blob,
    private readonly options: UploadOptions = {},
    config: UploadConfig = {},
  ) {
    this.filename = options.filename ?? (typeof File !== 'undefined' && file instanceof File ? file.name : '')
    this.contentType = options.contentType ?? file.type
    this.concurrency = options.concurrency ?? 3
    this.timeoutMs = config.uploadTimeoutMs ?? 120_000
    this.store = new ResumeStore(config.storage)
    if (!this.filename.trim() || this.filename.length > 255) {
      throw new PicGoCloudError('Provide a filename of 1–255 characters', { kind: 'validation' })
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_SIZE) {
      throw new PicGoCloudError('File size must be between 1 byte and 1 GiB', { kind: 'validation' })
    }
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 6
      || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PicGoCloudError('Invalid upload concurrency or timeout', { kind: 'validation' })
    }
    for (const dimension of [options.width, options.height]) {
      if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension <= 0)) {
        throw new PicGoCloudError('Image dimensions must be positive integers', { kind: 'validation' })
      }
    }
  }

  get status(): UploadStatus { return this.currentStatus }

  start(): Promise<MediaItem> {
    if (this.cancelling || this.currentStatus === 'cancelled') {
      return Promise.reject(new PicGoCloudError('Upload was cancelled; create a new task', { kind: 'aborted' }))
    }
    if (this.result) return Promise.resolve(this.result)
    if (this.running) return this.running
    this.controller = new AbortController()
    const signal = this.options.signal
      ? AbortSignal.any([this.controller.signal, this.options.signal]) : this.controller.signal
    this.currentStatus = 'running'
    this.running = this.execute(signal).then(
      result => {
        this.result = result
        this.currentStatus = 'completed'
        this.running = undefined
        return result
      },
      error => {
        this.currentStatus = this.cancelling ? 'cancelled'
          : signal.aborted && signal.reason instanceof PicGoCloudError && signal.reason.kind === 'paused' ? 'paused' : 'failed'
        this.running = undefined
        if (signal.aborted) throwIfAborted(signal)
        throw error
      },
    )
    return this.running
  }

  /** Stops local requests. Await/reject the pending start() before starting again. */
  pause(): void {
    this.controller?.abort(new PicGoCloudError('Upload paused', { kind: 'paused' }))
  }

  /** Cleans up an unfinished multipart session; does not delete committed media. */
  async cancel(): Promise<void> {
    if (this.result) return
    this.cancelling = true
    this.controller?.abort(new PicGoCloudError('Upload cancelled', { kind: 'aborted' }))
    try { await this.running } catch { /* The caller also receives the interrupted start(). */ }
    if (this.result) { this.cancelling = false; return }
    this.currentStatus = 'cancelled'
    const cleanup = async (): Promise<void> => {
      if (this.state?.uploadId && this.state.phase !== 'uploaded' && this.sessionHttp) {
        try {
          await this.sessionHttp.request('/api/upload/multipart/abort', {
            method: 'POST', body: { uploadId: this.state.uploadId, objectKey: this.state.objectKey },
          })
        } catch (error) {
          if (!(error instanceof PicGoCloudError) || error.status !== 404) throw error
        }
      }
      this.clear()
    }
    // A paused session may have been resumed by another task/tab in the meantime.
    if (this.key && this.state) await withUploadLock(this.key, new AbortController().signal, cleanup)
    else await cleanup()
  }

  private emit(phase: UploadPhase, loaded: number): void {
    const bounded = Math.min(this.file.size, Math.max(0, loaded))
    try {
      this.options.onProgress?.({ phase, loaded: bounded, total: this.file.size, fraction: bounded / this.file.size, resumed: this.resumed })
    } catch { /* Observers cannot change the outcome of an upload. */ }
  }

  private save(): void {
    if (this.key && this.state && this.options.resume !== false) this.store.set(this.key, this.state)
  }

  private clear(): void {
    if (this.key && this.state && this.options.resume !== false) this.store.remove(this.key)
    this.state = undefined
  }

  private async execute(signal: AbortSignal): Promise<MediaItem> {
    throwIfAborted(signal)
    this.emit('preparing', 0)
    const token = await this.http.resolveToken(signal)
    const sessionHttp = this.http.withToken(token)
    // Pin the token throughout one attempt; never mix accounts across parts.
    const identity = await sessionHttp.request<{ userId?: string }>('/api/whoami', { signal })
    const owner = identity.userId || `token:${await digest(token)}`
    if (this.owner && this.owner !== owner) {
      throw new PicGoCloudError('The account changed; create a new upload task', { kind: 'validation' })
    }
    this.owner = owner
    this.sessionHttp = sessionHttp
    this.uploadToken = token
    if (this.file.size < MULTIPART_THRESHOLD) return this.single(sessionHttp, signal)

    const hash = await fingerprint(this.file, this.filename, this.contentType, signal)
    const scope = await digest(JSON.stringify([this.http.baseUrl, owner, hash]))
    this.key = `picgo-cloud-sdk:upload:v1:${scope}`
    return withUploadLock(this.key, signal, async () => {
      this.state ??= this.options.resume === false ? undefined : this.store.get(this.key!, this.file.size)
      this.resumed = Boolean(this.state)
      try { return await this.multipart(this.sessionHttp!, signal) } catch (error) {
        // A vanished multipart session cannot be resumed. The next start creates a fresh one.
        if (error instanceof PicGoCloudError && error.status === 404 && this.state?.phase === 'uploading') this.clear()
        throw error
      }
    })
  }

  private uploadTarget(url: string, headers: Record<string, string>): { url: string; headers: Record<string, string> } {
    const target = new URL(url, this.http.baseUrl)
    const api = new URL(this.http.baseUrl)
    const isLocalProxy = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)
      && target.origin === api.origin
      && (/^\/api\/upload\/put\/.+/.test(target.pathname)
        || /^\/api\/upload\/multipart-local\/[^/]+\/part\/\d+$/.test(target.pathname))
    return { url: target.href, headers: isLocalProxy ? { ...headers, Authorization: `Bearer ${this.uploadToken}` } : headers }
  }

  private async finalize(http: HttpClient, signal: AbortSignal): Promise<MediaItem> {
    const state = this.state!
    this.emit('completing', this.file.size)
    let result: { item: MediaItemResponse }
    try {
      result = await retry(() => http.request<{ item: MediaItemResponse }>('/api/album-items/complete', {
        method: 'POST', signal,
        body: { objectKey: state.objectKey, publicId: state.publicId, filename: this.filename, width: this.options.width, height: this.options.height },
      }), signal)
    } catch (error) {
      if (state.phase === 'uploaded' && error instanceof PicGoCloudError && error.status === 404) this.clear()
      throw error
    }
    if (!result?.item) {
      protocol('Invalid media completion response')
    }
    const item = normalizeMediaItem(result.item)
    this.clear()
    this.emit('completed', this.file.size)
    return item
  }

  private async single(http: HttpClient, signal: AbortSignal): Promise<MediaItem> {
    if (this.state?.phase === 'uploaded') {
      this.resumed = true
      return this.finalize(http, signal)
    }
    let presign = await this.presign(http, signal)
    for (let attempt = 0; ; attempt++) {
      this.state = { version: 1, createdAt: Date.now(), objectKey: presign.objectKey, publicId: presign.publicId,
        partSize: this.file.size, partCount: 1, completedParts: [], phase: 'uploading' }
      const headers = { ...presign.headers }
      if (this.contentType && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = this.contentType
      try {
        await putBlob({ ...this.uploadTarget(presign.uploadUrl, headers), body: this.file, signal, timeoutMs: this.timeoutMs,
          onProgress: loaded => this.emit('uploading', loaded) })
        break
      } catch (error) {
        const wait = BACKOFF[attempt]
        if (wait === undefined) throw error
        if (error instanceof PicGoCloudError && error.status === 403) presign = await this.presign(http, signal)
        else if (!isRetryable(error)) throw error
        await delay(wait, signal)
      }
    }
    this.state!.phase = 'uploaded'
    return this.finalize(http, signal)
  }

  private async presign(http: HttpClient, signal: AbortSignal): Promise<PresignResult> {
    const data = await http.request<PresignResult>('/api/upload/presign', {
      method: 'POST', signal, body: { filename: this.filename, contentType: this.contentType || undefined, sizeBytes: this.file.size },
    })
    if (!data || typeof data.objectKey !== 'string' || typeof data.publicId !== 'string'
      || typeof data.uploadUrl !== 'string' || data.method !== 'PUT' || typeof data.headers !== 'object' || !data.headers) {
      protocol('Invalid upload presign response')
    }
    return data
  }

  private async multipart(http: HttpClient, signal: AbortSignal): Promise<MediaItem> {
    let signedParts: SignedPart[] = []
    if (!this.state) {
      const data = await http.request<MultipartSession>('/api/upload/multipart/initiate', {
        method: 'POST', signal, body: { filename: this.filename, contentType: this.contentType || undefined, sizeBytes: this.file.size },
      })
      validateSession(data, this.file.size)
      this.state = { version: 1, createdAt: Date.now(), uploadId: data.uploadId, objectKey: data.objectKey,
        publicId: data.publicId, partSize: data.partSize, partCount: data.partCount, completedParts: [], phase: 'uploading' }
      signedParts = data.parts
      this.save()
    }
    const state = this.state
    if (state.phase === 'uploaded') return this.finalize(http, signal)
    // A lost merge response may mean R2 already committed the object. Probe the
    // idempotent registration endpoint before attempting the merge again.
    if (state.phase === 'merging') {
      try { return await this.finalize(http, signal) } catch (error) {
        if (!(error instanceof PicGoCloudError) || error.status !== 404) throw error
      }
    }
    if (state.phase === 'uploading') await this.parts(http, signedParts, signal)
    state.phase = 'merging'
    this.save()
    try {
      await http.request('/api/upload/multipart/complete', {
        method: 'POST', signal, body: { uploadId: state.uploadId, objectKey: state.objectKey,
          parts: [...state.completedParts].sort((a, b) => a.partNumber - b.partNumber) },
      })
    } catch (error) {
      if (error instanceof PicGoCloudError && error.code === ApiErrorCode.MultipartPartMismatch) {
        this.clear()
        try {
          await http.request('/api/upload/multipart/abort', {
            method: 'POST', signal, body: { uploadId: state.uploadId, objectKey: state.objectKey },
          })
        } catch { /* Preserve the merge error; the server also expires orphan sessions. */ }
        throw error
      }
      if (!isRetryable(error) && !(error instanceof PicGoCloudError && error.status === 404)) throw error
      // Don't blindly retry a potentially committed merge.
      try { return await this.finalize(http, signal) } catch (completionError) {
        if (completionError instanceof PicGoCloudError && completionError.status === 404
          && error instanceof PicGoCloudError && error.status === 404) this.clear()
        throw error
      }
    }
    state.phase = 'uploaded'
    this.save()
    return this.finalize(http, signal)
  }

  private async parts(http: HttpClient, initial: SignedPart[], signal: AbortSignal): Promise<void> {
    const state = this.state!
    const completed = new Set(state.completedParts.map(part => part.partNumber))
    const remaining = Array.from({ length: state.partCount }, (_, index) => index + 1).filter(number => !completed.has(number))
    const signed = new Map(initial.map(part => [part.partNumber, part]))
    const progress = new Map<number, number>()
    const partBytes = (number: number) => Math.min(state.partSize, this.file.size - (number - 1) * state.partSize)
    const emit = () => this.emit('uploading', state.completedParts.reduce((sum, part) => sum + partBytes(part.partNumber), 0)
      + [...progress.values()].reduce((sum, value) => sum + value, 0))
    emit()
    const stop = new AbortController()
    const groupSignal = AbortSignal.any([signal, stop.signal])
    let cursor = 0
    const refresh = async (number: number): Promise<SignedPart> => {
      const response = await retry(() => http.request<{ parts: SignedPart[] }>('/api/upload/multipart/part-urls', {
        method: 'POST', signal: groupSignal, body: { uploadId: state.uploadId, objectKey: state.objectKey, partNumbers: [number] },
      }), groupSignal)
      const part = response?.parts?.find(part => part.partNumber === number)
      if (!part) protocol('Missing signed multipart URL')
      signed.set(number, part)
      return part
    }
    const worker = async (): Promise<void> => {
      try {
        while (cursor < remaining.length) {
          throwIfAborted(groupSignal)
          const number = remaining[cursor++]!
          const start = (number - 1) * state.partSize
          const body = this.file.slice(start, start + state.partSize)
          let part = signed.get(number) ?? await refresh(number)
          for (let attempt = 0; ; attempt++) {
            throwIfAborted(groupSignal)
            if (part.method !== 'PUT' || typeof part.url !== 'string' || !part.headers) protocol('Invalid signed multipart URL')
            try {
              const result = await putBlob({ ...this.uploadTarget(part.url, part.headers), body, signal: groupSignal, timeoutMs: this.timeoutMs,
                onProgress: loaded => { progress.set(number, Math.min(body.size, loaded)); emit() } })
              if (!result.etag || result.etag.length > 256) protocol('Upload response has no valid ETag; expose ETag in the R2 CORS configuration')
              progress.delete(number)
              state.completedParts.push({ partNumber: number, etag: result.etag })
              this.save()
              emit()
              break
            } catch (error) {
              progress.delete(number)
              const wait = BACKOFF[attempt]
              if (wait === undefined) throw error
              if (error instanceof PicGoCloudError && error.status === 403) part = await refresh(number)
              else if (!isRetryable(error)) throw error
              await delay(wait, groupSignal)
            }
          }
        }
      } catch (error) { stop.abort(error); throw error }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(this.concurrency, remaining.length) }, worker))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw stop.signal.reason ?? failure.reason
    throwIfAborted(signal)
  }
}
