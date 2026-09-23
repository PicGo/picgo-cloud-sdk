export type PicGoCloudErrorKind =
  | 'api'
  | 'authentication'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'paused'
  | 'validation'
  | 'protocol'
  | 'storage'
  | 'upload'

export interface PicGoCloudErrorOptions {
  kind: PicGoCloudErrorKind
  status?: number
  code?: string
  cause?: unknown
}

export class PicGoCloudError extends Error {
  readonly kind: PicGoCloudErrorKind
  readonly status?: number
  readonly code?: string
  override readonly cause?: unknown

  constructor(message: string, options: PicGoCloudErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PicGoCloudError'
    this.kind = options.kind
    this.status = options.status
    this.code = options.code
    this.cause = options.cause
  }
}

export function isPicGoCloudError(error: unknown): error is PicGoCloudError {
  return error instanceof PicGoCloudError
}
