import { describe, expect, it, vi } from 'vitest'
import { PicGoCloudClient } from '../src/client.js'
import { normalizeMediaItem } from '../src/media-item.js'

describe('MediaItem URLs', () => {
  it('supports video URLs and supplies the compatibility field', () => {
    expect(normalizeMediaItem({ id: 'video', url: 'https://media.example/video.mp4', contentType: 'video/mp4' }))
      .toEqual({ id: 'video', url: 'https://media.example/video.mp4', imgUrl: 'https://media.example/video.mp4', contentType: 'video/mp4' })
  })

  it('uses a legacy address when url is absent and preserves current cloud domains', () => {
    expect(normalizeMediaItem({ id: 'legacy', imgUrl: 'https://media.example/file.pdf' }).url).toBe('https://media.example/file.pdf')
    expect(normalizeMediaItem({ id: 'cloud', type: 'picgo-cloud', url: 'https://old.example/a.mp4', imgUrl: 'https://current.example/a.mp4' }).url)
      .toBe('https://current.example/a.mp4')
    expect(normalizeMediaItem({ id: 'external', url: 'https://media.example/a.mp4', imgUrl: 'https://media.example/preview.png' }).url)
      .toBe('https://media.example/a.mp4')
  })

  it('rejects missing or blank URLs instead of returning an unusable media item', () => {
    expect(() => normalizeMediaItem({ id: 'missing' })).toThrow('Media item response has no URL')
    expect(() => normalizeMediaItem({ id: 'blank', url: ' ', imgUrl: '' })).toThrow('Media item response has no URL')
  })

  it('normalizes list, detail, update, and batch update results consistently', async () => {
    const legacy = { id: 'legacy', imgUrl: 'https://media.example/legacy.png' }
    const video = { id: 'video', url: 'https://media.example/video.mp4', contentType: 'video/mp4' }
    const respond = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(respond({ items: [legacy, video], total: 2, limit: 20, offset: 0 }))
      .mockResolvedValueOnce(respond({ item: legacy }))
      .mockResolvedValueOnce(respond({ item: video }))
      .mockResolvedValueOnce(respond({ items: [legacy, video], updated: 2, skipped: 0 }))
    const client = new PicGoCloudClient({ token: 'test-token', fetch: fetchMock })
    const urls = ['https://media.example/legacy.png', 'https://media.example/video.mp4']
    expect((await client.media.list()).items.map(item => item.url)).toEqual(urls)
    expect((await client.media.get('legacy')).url).toBe(urls[0])
    expect((await client.media.update('video', { fileName: 'renamed.mp4' })).url).toBe(urls[1])
    const batch = await client.media.updateMany([{ id: 'legacy' }, { id: 'video' }])
    expect(batch.items.map(item => item.url)).toEqual(urls)
    expect(batch.updated).toBe(2)
  })
})
