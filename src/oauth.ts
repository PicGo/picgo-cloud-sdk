import { PicGoCloudError } from './errors.js'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, normalizeBaseUrl } from './http.js'

export interface PicGoCloudOAuthOptions {
  clientId: string
  /** Confidential credential: use this class only on your server. */
  clientSecret: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface OAuthTokens {
  accessToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
  /** Epoch milliseconds computed when the response arrived. */
  expiresAt: number
  scope: string
  refreshToken?: string
}

export interface OAuthAuthorizationRequest {
  /** Absolute `/oauth/authorize` URL to send the user to. */
  url: string
  /** Compare with the callback `state` before exchanging the code. */
  state: string
  /** Keep server-side until the callback; required by `exchangeCode`. */
  codeVerifier: string
}

const random = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PicGoCloudError(`${name} must be a non-empty string`, { kind: 'validation' })
  }
  return value
}

/**
 * Server-side OAuth helpers for PicGo Cloud partners: authorization URL with PKCE,
 * code exchange, refresh, revocation and a cached access-token provider for `PicGoCloudClient`.
 */
export class PicGoCloudOAuth {
  readonly baseUrl: string
  private readonly clientId: string
  private readonly basic: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: PicGoCloudOAuthOptions) {
    this.clientId = nonEmpty(options.clientId, 'clientId')
    nonEmpty(options.clientSecret, 'clientSecret')
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new PicGoCloudError('timeoutMs must be a positive number', { kind: 'validation' })
    }
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new PicGoCloudError('This runtime does not provide fetch', { kind: 'validation' })
    }
    this.fetchImpl = fetchImpl.bind(globalThis)
    // client_secret_basic: RFC 6749 form-encodes both parts before Base64.
    const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')
    this.basic = btoa(String.fromCharCode(...new TextEncoder().encode(`${encode(this.clientId)}:${encode(options.clientSecret)}`)))
  }

  async createAuthorization(options: { redirectUri: string; scopes: string[] | string; state?: string }): Promise<OAuthAuthorizationRequest> {
    const scope = Array.isArray(options.scopes) ? options.scopes.join(' ') : options.scopes
    nonEmpty(options.redirectUri, 'redirectUri')
    nonEmpty(scope, 'scopes')
    const state = options.state ?? random()
    const codeVerifier = random()
    const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))))
    const query = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: options.redirectUri,
      scope,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    })
    return { url: `${this.baseUrl}/oauth/authorize?${query.toString()}`, state, codeVerifier }
  }

  async exchangeCode(options: { code: string; codeVerifier: string; redirectUri: string; signal?: AbortSignal }): Promise<OAuthTokens & { refreshToken: string }> {
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code: nonEmpty(options.code, 'code'),
      code_verifier: nonEmpty(options.codeVerifier, 'codeVerifier'),
      redirect_uri: nonEmpty(options.redirectUri, 'redirectUri'),
    }, options.signal)
    if (!tokens.refreshToken) {
      throw new PicGoCloudError('PicGo Cloud did not return a refresh token', { kind: 'protocol' })
    }
    return tokens as OAuthTokens & { refreshToken: string }
  }

  /** Throws `code: 'invalid_grant'` when the user revoked access or the token was revoked. */
  async refresh(refreshToken: string, options: { signal?: AbortSignal } = {}): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: nonEmpty(refreshToken, 'refreshToken') }, options.signal)
  }

  /** Revokes a refresh token (and its access tokens) or a single access token. */
  async revoke(token: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.post('/oauth/revoke', { token: nonEmpty(token, 'token') }, options.signal)
  }

  /**
   * Token provider for `new PicGoCloudClient({ token })`: refreshes 30 seconds before expiry
   * and shares one in-flight refresh between concurrent requests.
   * shortcut: assumes refresh tokens do not rotate (true today); persist `refreshToken` from responses if that changes.
   */
  tokenProvider(refreshToken: string | (() => string | Promise<string>)): () => Promise<string> {
    let cached: OAuthTokens | undefined
    let pending: Promise<OAuthTokens> | undefined
    return async () => {
      if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken
      pending ??= Promise.resolve(typeof refreshToken === 'function' ? refreshToken() : refreshToken)
        .then(token => this.refresh(token))
        .finally(() => { pending = undefined })
      cached = await pending
      return cached.accessToken
    }
  }

  private async token(params: Record<string, string>, signal?: AbortSignal): Promise<OAuthTokens> {
    const payload = await this.post('/oauth/token', params, signal)
    if (!isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token
      || typeof payload.expires_in !== 'number' || !(payload.expires_in > 0) || typeof payload.scope !== 'string') {
      throw new PicGoCloudError('PicGo Cloud returned an invalid token response', { kind: 'protocol' })
    }
    return {
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
      expiresAt: Date.now() + payload.expires_in * 1000,
      scope: payload.scope,
      ...(typeof payload.refresh_token === 'string' && payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    }
  }

  private async post(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new PicGoCloudError('The request was aborted', { kind: 'aborted', cause: signal.reason })
    const timeout = AbortSignal.timeout(this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${this.basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
        credentials: 'omit',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (cause) {
      if (signal?.aborted) throw new PicGoCloudError('The request was aborted', { kind: 'aborted', cause })
      if (timeout.aborted) throw new PicGoCloudError(`PicGo Cloud OAuth request timed out after ${this.timeoutMs}ms`, { kind: 'timeout', cause })
      throw new PicGoCloudError('PicGo Cloud OAuth request failed', { kind: 'network', cause })
    }
    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) as unknown : undefined
    } catch (cause) {
      throw new PicGoCloudError('PicGo Cloud returned malformed JSON', { kind: 'protocol', status: response.status, cause })
    }
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : undefined
      throw new PicGoCloudError(`PicGo Cloud OAuth error: ${code ?? response.status}`, {
        kind: code === 'invalid_client' || code === 'invalid_grant' ? 'authentication' : 'api',
        status: response.status,
        code,
      })
    }
    return payload
  }
}
