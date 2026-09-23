import { PicGoCloudError } from './errors.js'
import type { HttpClient } from './http.js'
import type {
  MediaBulkDeleteResult,
  MediaBulkUpdateItem,
  MediaBulkUpdateResult,
  MediaDeleteResult,
  MediaFilters,
  MediaItem,
  MediaListQuery,
  MediaListResult,
  MediaStats,
  MediaUpdate,
  RequestOptions,
} from './types.js'

type MediaItemResult = { item: MediaItem }
const RESERVED_MEDIA_IDS = new Set(['complete', 'filters', 'stats'])

function validation(message: string): never {
  throw new PicGoCloudError(message, { kind: 'validation' })
}

function validateMediaId(id: unknown): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    validation('Media id cannot be empty')
  }
  if (RESERVED_MEDIA_IDS.has(id.toLowerCase())) {
    validation(`Media id cannot use the reserved path ${id}`)
  }
}

function validateListQuery(query: MediaListQuery): void {
  if (query.limit !== undefined
    && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    validation('Media list limit must be an integer between 1 and 100')
  }
  if (query.offset !== undefined
    && (!Number.isSafeInteger(query.offset) || query.offset < 0)) {
    validation('Media list offset must be a non-negative integer')
  }
}

function validateBatch<T>(values: T[], name: string): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    validation(`${name} must contain between 1 and 100 items`)
  }
}

function addQueryValue(params: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value !== undefined) {
    params.set(key, String(value))
  }
}

export class MediaService {
  constructor(private readonly http: HttpClient) {}

  async list(query: MediaListQuery = {}, options: RequestOptions = {}): Promise<MediaListResult> {
    validateListQuery(query)
    const params = new URLSearchParams()
    addQueryValue(params, 'limit', query.limit)
    addQueryValue(params, 'offset', query.offset)
    addQueryValue(params, 'search', query.search)
    addQueryValue(params, 'contentType', query.contentType)
    addQueryValue(params, 'ext', query.ext)
    addQueryValue(params, 'fileName', query.fileName)
    addQueryValue(params, 'type', query.type)
    addQueryValue(params, 'sort', query.sort)
    addQueryValue(params, 'order', query.order)

    const queryString = params.toString()
    return await this.http.request<MediaListResult>(
      `/api/album-items${queryString ? `?${queryString}` : ''}`,
      { signal: options.signal },
    )
  }

  async get(id: string, options: RequestOptions = {}): Promise<MediaItem> {
    validateMediaId(id)
    const result = await this.http.request<MediaItemResult>(
      `/api/album-items/${encodeURIComponent(id)}`,
      { signal: options.signal },
    )
    return result.item
  }

  async update(id: string, changes: MediaUpdate, options: RequestOptions = {}): Promise<MediaItem> {
    validateMediaId(id)
    const result = await this.http.request<MediaItemResult>(
      `/api/album-items/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: changes, signal: options.signal },
    )
    return result.item
  }

  async updateMany(
    items: MediaBulkUpdateItem[],
    options: RequestOptions = {},
  ): Promise<MediaBulkUpdateResult> {
    validateBatch(items, 'Media updates')
    for (const item of items) {
      if (typeof item !== 'object' || item === null || !('id' in item)) {
        validation('Each media update must include an id')
      }
      validateMediaId(item.id)
    }
    return await this.http.request<MediaBulkUpdateResult>('/api/album-items', {
      method: 'PATCH',
      body: { items },
      signal: options.signal,
    })
  }

  async delete(id: string, options: RequestOptions = {}): Promise<MediaDeleteResult> {
    validateMediaId(id)
    return await this.http.request<MediaDeleteResult>(
      `/api/album-items/${encodeURIComponent(id)}`,
      { method: 'DELETE', signal: options.signal },
    )
  }

  async deleteMany(ids: string[], options: RequestOptions = {}): Promise<MediaBulkDeleteResult> {
    validateBatch(ids, 'Media ids')
    for (const id of ids) {
      validateMediaId(id)
    }
    return await this.http.request<MediaBulkDeleteResult>('/api/album-items', {
      method: 'DELETE',
      body: { ids },
      signal: options.signal,
    })
  }

  async filters(options: RequestOptions = {}): Promise<MediaFilters> {
    return await this.http.request<MediaFilters>('/api/album-items/filters', {
      signal: options.signal,
    })
  }

  async stats(options: RequestOptions = {}): Promise<MediaStats> {
    return await this.http.request<MediaStats>('/api/album-items/stats', {
      signal: options.signal,
    })
  }
}
