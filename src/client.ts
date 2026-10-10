import { HttpClient } from './http.js'
import type { HttpClientConfig } from './http.js'
import { MediaService } from './media.js'
import type {
  RequestOptions, WhoAmI, MediaItem, RedeemInput, RedeemResult, StorageUsage, Entitlements, UploadTaskQuery, UploadTaskStatus,
} from './types.js'
import { UploadTask } from './upload/task.js'
import type { UploadConfig, UploadOptions } from './upload/types.js'

export interface PicGoCloudClientOptions extends HttpClientConfig, UploadConfig {}

export class PicGoCloudClient {
  readonly media: MediaService
  private readonly http: HttpClient

  constructor(private readonly options: PicGoCloudClientOptions) {
    this.http = new HttpClient(options)
    this.media = new MediaService(this.http)
  }

  whoami(options?: RequestOptions): Promise<WhoAmI> {
    return this.http.request<WhoAmI>('/api/whoami', options)
  }

  /** Redeem for the OAuth token's user. Requires entitlements:redeem; submission confirms redemption. */
  redeem(input: RedeemInput, options?: RequestOptions): Promise<RedeemResult> {
    return this.http.request<RedeemResult>('/api/redeem', { ...options, method: 'POST', body: input })
  }

  /** Requires storage:usage:read. */
  getStorageUsage(options?: RequestOptions): Promise<StorageUsage> {
    return this.http.request<StorageUsage>('/api/storage/usage', options)
  }

  /** Requires entitlements:read. */
  getEntitlements(options?: RequestOptions): Promise<Entitlements> {
    return this.http.request<Entitlements>('/api/entitlements', options)
  }

  /** Server-side upload task state for an upload started by the same user and OAuth client. Requires files:upload. */
  getUploadStatus(query: UploadTaskQuery, options?: RequestOptions): Promise<UploadTaskStatus> {
    const params = new URLSearchParams({ objectKey: query.objectKey })
    if (query.uploadId) params.set('uploadId', query.uploadId)
    return this.http.request<UploadTaskStatus>(`/api/upload/status?${params.toString()}`, options)
  }

  createUpload(file: Blob, options?: UploadOptions): UploadTask {
    return new UploadTask(this.http, file, options, this.options)
  }

  async upload(file: Blob, options?: UploadOptions): Promise<MediaItem> {
    return this.createUpload(file, options).start()
  }
}
