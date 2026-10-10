import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PicGoCloudClient, PicGoCloudOAuth } from '../src/index.js'

const tokenResponse = (extra: Record<string, unknown> = {}) =>
  Response.json({ access_token: 'pgoa_access', token_type: 'Bearer', expires_in: 600, scope: 'account:read', ...extra })

function oauth(fetch: typeof globalThis.fetch, secret = 'secret value') {
  return new PicGoCloudOAuth({ baseUrl: 'https://api.example.test/', clientId: 'partner', clientSecret: secret, fetch })
}

describe('PicGoCloudOAuth', () => {
  it('builds a PKCE S256 authorization URL', async () => {
    const auth = await oauth(fetch).createAuthorization({ redirectUri: 'https://partner.test/callback', scopes: ['account:read', 'files:upload'] })
    const url = new URL(auth.url)
    expect(url.origin + url.pathname).toBe('https://api.example.test/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'partner', response_type: 'code', redirect_uri: 'https://partner.test/callback',
      scope: 'account:read files:upload', state: auth.state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(auth.codeVerifier).digest('base64url'),
    })
    expect(auth.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(auth.state).not.toBe(auth.codeVerifier)
  })

  it('exchanges a code with client_secret_basic and a form body without client credentials', async () => {
    const client = oauth(async (url, init) => {
      expect(url).toBe('https://api.example.test/oauth/token')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from('partner:secret+value').toString('base64')}`)
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
      expect(init?.credentials).toBe('omit')
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'authorization_code', code: 'pgoc_code', code_verifier: 'v'.repeat(43), redirect_uri: 'https://partner.test/callback',
      })
      return tokenResponse({ refresh_token: 'pgor_refresh' })
    })
    const before = Date.now()
    const tokens = await client.exchangeCode({ code: 'pgoc_code', codeVerifier: 'v'.repeat(43), redirectUri: 'https://partner.test/callback' })
    expect(tokens).toMatchObject({ accessToken: 'pgoa_access', refreshToken: 'pgor_refresh', expiresIn: 600, scope: 'account:read' })
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 600_000)
  })

  it('rejects a code exchange without a refresh token', async () => {
    await expect(oauth(async () => tokenResponse()).exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }))
      .rejects.toMatchObject({ kind: 'protocol' })
  })

  it('refreshes without scope and surfaces invalid_grant as an authentication error', async () => {
    const bodies: string[] = []
    const client = oauth(async (_url, init) => {
      bodies.push(String(init?.body))
      return bodies.length === 1 ? tokenResponse() : Response.json({ error: 'invalid_grant' }, { status: 400 })
    })
    expect(await client.refresh('pgor_refresh')).toMatchObject({ accessToken: 'pgoa_access' })
    expect(bodies[0]).toBe('grant_type=refresh_token&refresh_token=pgor_refresh')
    await expect(client.refresh('pgor_refresh')).rejects.toMatchObject({ kind: 'authentication', status: 400, code: 'invalid_grant' })
  })

  it('revokes a token', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    await oauth(fetch).revoke('pgor_refresh')
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/oauth/revoke', expect.objectContaining({ body: 'token=pgor_refresh' }))
  })

  it('maps malformed, invalid and network responses', async () => {
    await expect(oauth(async () => Response.json({ access_token: 'a' })).refresh('r')).rejects.toMatchObject({ kind: 'protocol' })
    await expect(oauth(async () => new Response('<html>', { status: 502 })).refresh('r')).rejects.toMatchObject({ kind: 'protocol', status: 502 })
    await expect(oauth(async () => { throw new TypeError('offline') }).refresh('r')).rejects.toMatchObject({ kind: 'network' })
    await expect(oauth(async () => { throw new Error('must not send') }).refresh('r', { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('validates options', () => {
    expect(() => oauth(fetch, '')).toThrow('clientSecret')
    expect(() => new PicGoCloudOAuth({ clientId: 'p', clientSecret: 's', baseUrl: 'https://u:p@api.test' })).toThrow()
  })

  it('provides cached access tokens to PicGoCloudClient and shares one refresh', async () => {
    let refreshes = 0
    const oauthClient = oauth(async () => {
      refreshes += 1
      return tokenResponse({ access_token: `pgoa_${refreshes}` })
    })
    const loadRefreshToken = vi.fn(async () => 'pgor_refresh')
    const token = oauthClient.tokenProvider(loadRefreshToken)
    expect(await Promise.all([token(), token(), token()])).toEqual(['pgoa_1', 'pgoa_1', 'pgoa_1'])
    expect(await token()).toBe('pgoa_1')
    expect(refreshes).toBe(1)
    expect(loadRefreshToken).toHaveBeenCalledTimes(1)

    const api = new PicGoCloudClient({
      baseUrl: 'https://api.example.test',
      token,
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer pgoa_1')
        return Response.json({ success: true, data: { id: 'u1' } })
      },
    })
    await api.whoami()
  })

  it('refreshes again when the cached token is about to expire and retries after a failure', async () => {
    let calls = 0
    const token = oauth(async () => {
      calls += 1
      if (calls === 1) return Response.json({ error: 'server_error' }, { status: 500 })
      return tokenResponse({ access_token: `pgoa_${calls}`, expires_in: 20 })
    }).tokenProvider('pgor_refresh')
    await expect(token()).rejects.toMatchObject({ kind: 'api', code: 'server_error' })
    expect(await token()).toBe('pgoa_2')
    expect(await token()).toBe('pgoa_3')
  })
})
