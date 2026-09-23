import { PicGoCloudError } from '../errors.js'
import type { StoredUpload, UploadStorage } from './types.js'

const TTL = 24 * 60 * 60 * 1000

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof PicGoCloudError
      ? signal.reason
      : new PicGoCloudError('Upload interrupted', { kind: 'aborted', cause: signal.reason })
  }
}

export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Hash every byte using bounded buffers, avoiding a whole-file allocation. */
export async function fingerprint(file: Blob, filename: string, contentType: string, signal: AbortSignal): Promise<string> {
  const chunks: string[] = []
  const chunkSize = 8 * 1024 * 1024
  for (let start = 0; start < file.size; start += chunkSize) {
    throwIfAborted(signal)
    const chunk = await file.slice(start, start + chunkSize).arrayBuffer()
    chunks.push(hex(await crypto.subtle.digest('SHA-256', chunk)))
  }
  throwIfAborted(signal)
  return digest(JSON.stringify([filename, contentType, file.size, chunks]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function valid(value: unknown, fileSize: number): value is StoredUpload {
  if (!isRecord(value) || value.version !== 1 || typeof value.createdAt !== 'number'
    || value.createdAt > Date.now() || Date.now() - value.createdAt > TTL
    || typeof value.objectKey !== 'string' || !value.objectKey
    || typeof value.publicId !== 'string' || !value.publicId
    || typeof value.uploadId !== 'string' || !value.uploadId
    || typeof value.partSize !== 'number' || !Number.isSafeInteger(value.partSize) || value.partSize <= 0
    || typeof value.partCount !== 'number' || value.partCount < 1 || value.partCount > 10_000
    || value.partCount !== Math.ceil(fileSize / value.partSize)
    || !['uploading', 'merging', 'uploaded'].includes(String(value.phase))
    || !Array.isArray(value.completedParts)) return false
  const seen = new Set<number>()
  for (const part of value.completedParts) {
    if (!isRecord(part) || typeof part.partNumber !== 'number' || !Number.isInteger(part.partNumber)
      || part.partNumber < 1 || part.partNumber > value.partCount || seen.has(part.partNumber)
      || typeof part.etag !== 'string' || !part.etag || part.etag.length > 256) return false
    seen.add(part.partNumber)
  }
  return value.phase === 'uploading' || seen.size === value.partCount
}

export class ResumeStore {
  constructor(private readonly configured?: UploadStorage | false) {}

  private storage(): UploadStorage | undefined {
    try { return this.configured === false ? undefined : this.configured ?? globalThis.localStorage }
    catch { return undefined }
  }

  get(key: string, fileSize: number): StoredUpload | undefined {
    try {
      const raw = this.storage()?.getItem(key)
      if (!raw) return undefined
      const value: unknown = JSON.parse(raw)
      if (valid(value, fileSize)) return value
      this.remove(key)
    } catch { this.remove(key) }
    return undefined
  }

  set(key: string, state: StoredUpload): void {
    try { this.storage()?.setItem(key, JSON.stringify(state)) } catch { /* Keep the in-memory session. */ }
  }

  remove(key: string): void {
    try { this.storage()?.removeItem(key) } catch { /* Storage may be disabled by the browser. */ }
  }
}

const activeUploads = new Set<string>()

/** Cross-tab exclusion when Web Locks is available; same-page fallback otherwise. */
export async function withUploadLock<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    throwIfAborted(signal)
    if (activeUploads.has(key)) throw new PicGoCloudError('This file is already uploading', { kind: 'validation' })
    activeUploads.add(key)
    try { return await run() } finally { activeUploads.delete(key) }
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(key, { ifAvailable: true }, async lock => {
      if (!lock) throw new PicGoCloudError('This file is uploading in another tab', { kind: 'validation' })
      return execute()
    })
  }
  return execute()
}
