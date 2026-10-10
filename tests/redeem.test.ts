import { describe, expect, it } from 'vitest'
import { PicGoCloudClient } from '../src/index.js'

describe('PicGoCloudClient.redeem', () => {
  it('posts the voucher with the provider token, omits cookies and unwraps the entitlement', async () => {
    const client = new PicGoCloudClient({
      baseUrl: 'https://api.example.test',
      token: async () => 'pgoa_access',
      fetch: async (url, init) => {
        expect(url).toBe('https://api.example.test/api/redeem')
        expect(init?.method).toBe('POST')
        expect(init?.credentials).toBe('omit')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer pgoa_access')
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
        expect(JSON.parse(String(init?.body))).toEqual({ code: 'a'.repeat(43) })
        return Response.json({ success: true, data: { entitlementId: '42' } })
      },
    })
    expect(await client.redeem({ code: 'a'.repeat(43) })).toEqual({ entitlementId: '42' })
  })

  it('preserves redemption error status and code', async () => {
    const client = new PicGoCloudClient({
      token: 'pgoa_access',
      fetch: async () => Response.json({ success: false, code: 'REDEMPTION_ACTIVE_MEMBERSHIP', message: 'Active membership' }, { status: 409 }),
    })
    await expect(client.redeem({ code: 'a'.repeat(43) })).rejects.toMatchObject({
      kind: 'api', status: 409, code: 'REDEMPTION_ACTIVE_MEMBERSHIP',
    })
  })

  it('honors an aborted request without calling the transport', async () => {
    const client = new PicGoCloudClient({ token: 'token', fetch: async () => { throw new Error('must not send') } })
    await expect(client.redeem({ code: 'a'.repeat(43) }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'aborted' })
  })
})
