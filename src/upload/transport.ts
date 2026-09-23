import { PicGoCloudError } from '../errors.js'

export interface PutOptions {
  url: string
  headers: Record<string, string>
  body: Blob
  signal: AbortSignal
  timeoutMs: number
  onProgress?: (loaded: number) => void
}

export interface PutResult {
  etag?: string
}

function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch (cause) {
    throw new PicGoCloudError('The upload URL is invalid', {
      kind: 'validation',
      cause,
    })
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new PicGoCloudError('The upload URL must use HTTP or HTTPS', {
      kind: 'validation',
    })
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new PicGoCloudError('The upload timeout must be a non-negative number', {
      kind: 'validation',
    })
  }
}

export async function putBlob(options: PutOptions): Promise<PutResult> {
  validateUrl(options.url)
  validateTimeout(options.timeoutMs)

  if (options.signal.aborted) {
    throw new PicGoCloudError('The upload was aborted', {
      kind: 'aborted',
      cause: options.signal.reason,
    })
  }

  return new Promise<PutResult>((resolve, reject) => {
    const request = new XMLHttpRequest()
    let settled = false

    const cleanup = (): void => {
      request.removeEventListener('load', handleLoad)
      request.removeEventListener('error', handleNetworkError)
      request.removeEventListener('abort', handleAbort)
      request.removeEventListener('timeout', handleTimeout)
      request.upload.removeEventListener('progress', handleProgress)
      options.signal.removeEventListener('abort', handleSignalAbort)
    }

    const resolveOnce = (result: PutResult): void => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve(result)
    }

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }

    function handleLoad(): void {
      if (request.status >= 200 && request.status < 300) {
        const etag = request.getResponseHeader('ETag')
        resolveOnce(etag ? { etag } : {})
        return
      }

      rejectOnce(
        new PicGoCloudError(`The upload failed with status ${request.status}`, {
          kind: 'api',
          status: request.status,
        }),
      )
    }

    function handleNetworkError(event: Event): void {
      rejectOnce(
        new PicGoCloudError('A network error occurred while uploading', {
          kind: 'network',
          cause: event,
        }),
      )
    }

    function handleAbort(event: Event): void {
      rejectOnce(
        new PicGoCloudError('The upload was aborted', {
          kind: 'aborted',
          cause: options.signal.reason ?? event,
        }),
      )
    }

    function handleTimeout(event: Event): void {
      rejectOnce(
        new PicGoCloudError('The upload timed out', {
          kind: 'timeout',
          cause: event,
        }),
      )
    }

    function handleProgress(event: ProgressEvent): void {
      if (!options.onProgress) {
        return
      }

      try {
        options.onProgress(event.loaded)
      } catch (cause) {
        rejectOnce(cause)
        request.abort()
      }
    }

    function handleSignalAbort(): void {
      rejectOnce(
        new PicGoCloudError('The upload was aborted', {
          kind: 'aborted',
          cause: options.signal.reason,
        }),
      )
      request.abort()
    }

    request.addEventListener('load', handleLoad)
    request.addEventListener('error', handleNetworkError)
    request.addEventListener('abort', handleAbort)
    request.addEventListener('timeout', handleTimeout)
    request.upload.addEventListener('progress', handleProgress)
    options.signal.addEventListener('abort', handleSignalAbort, { once: true })

    try {
      request.open('PUT', options.url, true)
      request.withCredentials = false
      request.timeout = options.timeoutMs

      for (const [name, value] of Object.entries(options.headers)) {
        request.setRequestHeader(name, value)
      }

      request.send(options.body)
    } catch (cause) {
      rejectOnce(
        new PicGoCloudError('The upload request could not be started', {
          kind: 'api',
          cause,
        }),
      )
      request.abort()
    }
  })
}
