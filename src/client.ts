import { HttpClient } from './http.js'
import type { HttpClientConfig } from './http.js'
import { MediaService } from './media.js'
import type { RequestOptions, WhoAmI, MediaItem } from './types.js'
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

  createUpload(file: Blob, options?: UploadOptions): UploadTask {
    return new UploadTask(this.http, file, options, this.options)
  }

  async upload(file: Blob, options?: UploadOptions): Promise<MediaItem> {
    return this.createUpload(file, options).start()
  }
}
