export type UploadPhase = 'preparing' | 'uploading' | 'completing' | 'completed'
export type UploadStatus = 'idle' | 'running' | 'paused' | 'cancelled' | 'failed' | 'completed'

export interface UploadProgress {
  phase: UploadPhase
  loaded: number
  total: number
  /** Transfer fraction; await the task result to confirm media registration. */
  fraction: number
  resumed: boolean
}

/** Compatible with localStorage; failures degrade to in-memory resume. */
export interface UploadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface UploadOptions {
  /** Required for a Blob without a File name. */
  filename?: string
  contentType?: string
  width?: number
  height?: number
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
  /** Default true. Persistent recovery applies to multipart uploads only. */
  resume?: boolean
  /** Default 3; maximum 6. */
  concurrency?: number
}

export interface UploadConfig {
  /** Default localStorage. false disables persistence, but not same-task resume. */
  storage?: UploadStorage | false
  /** Timeout for each signed PUT, default 120 seconds. */
  uploadTimeoutMs?: number
}

export interface CompletedPart { partNumber: number; etag: string }
export interface SignedPart {
  partNumber: number
  url: string
  method: 'PUT'
  headers: Record<string, string>
}
export interface MultipartSession {
  uploadId: string
  objectKey: string
  publicId: string
  partSize: number
  partCount: number
  parts: SignedPart[]
}
export interface PresignResult {
  objectKey: string
  publicId: string
  uploadUrl: string
  method: 'PUT'
  headers: Record<string, string>
}

export interface StoredUpload {
  version: 1
  createdAt: number
  objectKey: string
  publicId: string
  uploadId?: string
  partSize: number
  partCount: number
  completedParts: CompletedPart[]
  phase: 'uploading' | 'merging' | 'uploaded'
}
