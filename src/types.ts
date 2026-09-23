export type TokenProvider = string | (() => string | Promise<string>)

export interface RequestOptions {
  signal?: AbortSignal
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
