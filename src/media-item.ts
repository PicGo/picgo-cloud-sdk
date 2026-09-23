import { PicGoCloudError } from './errors.js'
import type { MediaItem } from './types.js'

/** Transport compatibility stays internal; the public item always has a URL. */
export type MediaItemResponse = Omit<MediaItem, 'url' | 'imgUrl'> & {
  url?: string
  imgUrl?: string
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function normalizeMediaItem(item: MediaItemResponse): MediaItem {
  if (!item || !nonEmpty(item.id)) {
    throw new PicGoCloudError('Invalid media item response', { kind: 'protocol' })
  }
  // Cloud items may carry their current media domain in the legacy field while
  // url still contains the address saved when the item was created.
  const candidates = item.type === 'picgo-cloud' ? [item.imgUrl, item.url] : [item.url, item.imgUrl]
  const url = candidates.find(nonEmpty)
  if (!url) throw new PicGoCloudError('Media item response has no URL', { kind: 'protocol' })
  return { ...item, url, imgUrl: nonEmpty(item.imgUrl) ? item.imgUrl : url }
}
