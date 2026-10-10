export type TokenProvider = string | (() => string | Promise<string>)

export interface RequestOptions {
  signal?: AbortSignal
}

export interface RedeemInput {
  code: string
}

export interface RedeemResult {
  entitlementId: string
}

export interface UsageCounter {
  used: number
  limit: number
  remaining: number
}

export interface StorageUsage {
  /** Bytes. */
  storage: UsageCounter
  mediaCount: UsageCounter
  upload: { maxFileBytes: number; allowedExtensions: string[] }
}

export type LifecyclePhase = 'active' | 'grace' | 'frozen' | 'pending_cleanup'

export interface Entitlements {
  plan: string
  effectiveQuotaPlan: string
  phase: LifecyclePhase
  /** ISO timestamp, or null when the phase has no end. */
  currentPhaseEndsAt: string | null
  /** Informational; redeem() rechecks on the server. code is an API error code when not eligible. */
  redemption: { eligible: boolean; code: string | null }
}

export interface UploadTaskQuery {
  objectKey: string
  /** Required for multipart uploads. */
  uploadId?: string
}

export interface UploadTaskStatus {
  objectKey: string
  uploadId: string | null
  kind: 'single' | 'multipart'
  state: 'awaiting_object' | 'object_uploaded' | 'aborted'
  sizeBytes: number | null
  expiresAt: string
}

export interface WhoAmI {
  /** Available on current Workers; optional for compatibility with older deployments. */
  userId?: string
  user: string | null
  avatar: string | null
  plan: number
  autoImport: boolean
}

export interface MediaItem {
  id: string
  /** Media URL for images, videos, and other files. */
  url: string
  /** @deprecated Use url for media access. Retained for compatibility. */
  imgUrl: string
  fileName?: string
  type?: string
  contentType?: string
  size?: number
  width?: number
  height?: number
  extname?: string
  createdAt?: number
  updatedAt?: number
  originImgUrl?: string
  extra?: Record<string, unknown>
}

export type MediaSort = 'newest' | 'oldest' | 'fileName'
export type SortOrder = 'asc' | 'desc'

export interface MediaListQuery {
  limit?: number
  offset?: number
  search?: string
  contentType?: string
  ext?: string
  fileName?: string
  type?: string
  sort?: MediaSort
  order?: SortOrder
}

export interface MediaListResult {
  items: MediaItem[]
  limit: number
  offset: number
  total: number
}

export interface MediaUpdate {
  imgUrl?: string
  fileName?: string
  type?: string
  contentType?: string
  width?: number
  height?: number
  createdAt?: number
  updatedAt?: number
  originImgUrl?: string
  url?: string
  extra?: Record<string, unknown>
}

export type MediaBulkUpdateItem = MediaUpdate & { id: string }

export interface MediaBulkUpdateResult {
  updated: number
  skipped: number
  items: MediaItem[]
}

export interface MediaDeleteResult {
  message: string
}

export interface MediaBulkDeleteResult {
  deleted: number
}

export interface MediaFilters {
  contentTypes: string[]
  types: string[]
  exts: string[]
}

export interface MediaTypeStats {
  type: string
  count: number
}

export interface MediaStats {
  total: number
  types: MediaTypeStats[]
}
