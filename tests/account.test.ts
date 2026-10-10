import { describe, expect, it } from 'vitest'
import { PicGoCloudClient } from '../src/index.js'

function clientReturning(data: unknown, seen: string[]) {
  return new PicGoCloudClient({
    baseUrl: 'https://api.example.test',
    token: 'pgoa_access',
    fetch: async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer pgoa_access')
      return Response.json({ success: true, data })
    },
  })
}

describe('partner account reads', () => {
  it('reads storage usage and entitlements', async () => {
    const seen: string[] = []
    const usage = { storage: { used: 1, limit: 10, remaining: 9 }, mediaCount: { used: 1, limit: 5, remaining: 4 }, upload: { maxFileBytes: 5, allowedExtensions: ['png'] } }
    expect(await clientReturning(usage, seen).getStorageUsage()).toEqual(usage)
    const entitlements = { plan: 'pro', effectiveQuotaPlan: 'pro', phase: 'active', currentPhaseEndsAt: null, redemption: { eligible: false, code: 'REDEMPTION_ACTIVE_MEMBERSHIP' } }
    expect(await clientReturning(entitlements, seen).getEntitlements()).toEqual(entitlements)
    expect(seen).toEqual(['GET https://api.example.test/api/storage/usage', 'GET https://api.example.test/api/entitlements'])
  })

  it('encodes the upload task reference and omits uploadId for single uploads', async () => {
    const seen: string[] = []
    const status = { objectKey: 'u/a b.png', uploadId: null, kind: 'single', state: 'awaiting_object', sizeBytes: null, expiresAt: '2026-10-17T00:00:00.000Z' }
    expect(await clientReturning(status, seen).getUploadStatus({ objectKey: 'u/a b.png' })).toEqual(status)
    await clientReturning(status, seen).getUploadStatus({ objectKey: 'u/x', uploadId: 'up&1' })
    expect(seen).toEqual([
      'GET https://api.example.test/api/upload/status?objectKey=u%2Fa+b.png',
      'GET https://api.example.test/api/upload/status?objectKey=u%2Fx&uploadId=up%261',
    ])
  })
})
