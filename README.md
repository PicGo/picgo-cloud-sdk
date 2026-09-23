# @picgo/cloud-sdk

[中文文档](README_ZH.md)

A PicGo Cloud JavaScript SDK for modern browsers, written in TypeScript and built with Rolldown, with zero runtime dependencies. It provides file uploads, resumable multipart uploads, and media management without UI components. For Node.js, use PicGo-Core.

## Installation and usage

```sh
pnpm add @picgo/cloud-sdk
```

```ts
import { PicGoCloudClient } from '@picgo/cloud-sdk'

const client = new PicGoCloudClient({
  token: userToken,
})

const media = await client.upload(file)
console.log(media.id, media.imgUrl)

const page = await client.media.list({ limit: 20, offset: 0, search: 'travel' })
await client.media.update(media.id, { fileName: 'travel-photo.jpg' })
await client.media.delete(media.id)
```

The person using your application supplies their own token, which grants access to their account. The SDK sends `Authorization: Bearer`, omits cookies, and does not persist or log tokens by default. Do not embed the site developer's token in a public frontend bundle. You can supply a string, `token: () => currentToken`, or an asynchronous token provider. Each upload attempt uses a single token throughout to avoid switching accounts between parts.

```ts
const client = new PicGoCloudClient({
  token: async () => getCurrentUserToken(),
  baseUrl: 'https://api.picgo.app', // Default; use your Worker URL for local development
  timeoutMs: 30_000, // Timeout per API request
  uploadTimeoutMs: 120_000, // Timeout per file or part PUT
  // storage: false, // Disable persistent upload recovery
})
```

API requests use native fetch; you can inject an implementation through the `fetch` option. File transfers use native XMLHttpRequest for upload progress and do not use the custom fetch implementation. Importing the module does not access the DOM. Uploads require the browser's Blob/File, XMLHttpRequest, Web Crypto, and AbortSignal.any APIs. Use an HTTPS or localhost secure context.

## Uploading files

```ts
const media = await client.upload(file, {
  onProgress({ phase, loaded, total, fraction, resumed }) {
    console.log(phase, loaded, total, fraction, resumed)
  },
})

// A Blob has no filename, so provide one explicitly.
await client.upload(blob, { filename: 'photo.png', contentType: 'image/png' })
```

Files smaller than 10 MiB use a single presigned PUT; files at or above 10 MiB automatically use multipart uploads. Part sizes come from the server. The default concurrency is 3 and can be set to 1–6 using `concurrency`. The SDK accepts files from 1 byte to 1 GiB; the server still enforces supported formats, size limits by media type, plans, and quotas. Files are not converted, compressed, or re-encoded. Use `width` and `height` to supply image dimensions.

The `phase` is `preparing`, `uploading`, `completing`, or `completed`. The `fraction` measures byte transfer only: reaching 100% may still leave multipart completion and media registration to finish. The upload is complete only when its Promise resolves. Transfer progress can decrease during retries. Exceptions thrown by progress callbacks do not affect the upload result.

### Pausing, resuming, and cancelling

```ts
import { PicGoCloudError } from '@picgo/cloud-sdk'

const task = client.createUpload(file, { onProgress: updateProgress })

pauseButton.addEventListener('click', () => task.pause())
cancelButton.addEventListener('click', async () => {
  try {
    await task.cancel()
  } catch (error) {
    showError(error) // Call cancel() again to retry cleanup after a network failure
  }
})

async function startOrResume() {
  try {
    const media = await task.start()
    showUploadedMedia(media)
  } catch (error) {
    if (error instanceof PicGoCloudError && error.kind === 'paused') return
    showError(error)
  }
}

startButton.addEventListener('click', startOrResume)
resumeButton.addEventListener('click', startOrResume)
```

`createUpload()` does not send requests immediately. Call `start()` to begin; repeated calls while it is running return the same Promise. `pause()` interrupts the current requests and rejects that Promise with `kind: 'paused'`; once it settles, call `start()` again to continue. `cancel()` interrupts the upload and cleans up an unfinished multipart session. Create a new task after cancellation. Cleanup failures are reported to the caller, and recovery records remain available for another attempt. Cancellation does not roll back registered media; uploaded objects that were never registered are handled by the server's cleanup policy.

The `task.status` is `idle`, `running`, `paused`, `cancelled`, `failed`, or `completed`. If your application already uses an AbortController, you can pass its `signal`. Aborting an external signal retains recovery information and does not perform the server cleanup that `cancel()` does. An already-aborted external signal cannot be reused to restart an upload; create a new task.

### Resumable uploads

By default, multipart uploads store their session and completed part ETags in the current site's localStorage, with a 24-hour cache lifetime. After refreshing the page, select the original file and call `upload()` or `createUpload().start()` to resume automatically. The SDK identifies files using chunked content hashes, reading the file during preparation without loading it all into memory. Records are isolated by API URL, account, and file. They contain no tokens, presigned URLs, or file contents.

Newer Workers expose `whoami.userId` for account isolation, allowing the same account to resume after changing tokens. Older Workers without this field use a token hash for isolation, so changing the token will not match previous records. A task cannot switch accounts. When available, Web Locks prevent multiple tabs from resuming the same file simultaneously; otherwise, exclusion applies only within the current page.

Recovery requires the current site's local record, the same file, and an unexpired server session. It does not work across sites or devices. If browser storage is unavailable, recovery falls back to the task's in-memory state. Set `storage: false` to disable persistence, or `resume: false` to ignore persisted records for an upload. Small files cannot resume across page refreshes, but retrying registration on the same task does not repeat the PUT. Multipart uploads retain their merged-but-unregistered state until registration succeeds.

The SDK retries only steps that can safely be retried. Part PUTs receive up to 3 additional attempts with 1/2/4-second backoff; a 403 triggers a new signed URL. Media updates, deletions, and upload session creation are not silently retried. If the multipart completion response is lost, the SDK first attempts idempotent media registration to determine whether the object was already assembled, rather than immediately creating another upload.

## Media management

PicGo Cloud's current album is a list of media items, with no separate album grouping entity. The `media` API maps to `/api/album-items`, does not use the deprecated `/api/media`, and does not import records from third-party image hosts.

| Method | Returns |
| --- | --- |
| `client.whoami(options?)` | Current user details, including `userId` on newer servers |
| `client.media.list(query?, options?)` | `{ items, total, limit, offset }` |
| `client.media.get(id, options?)` | `MediaItem` |
| `client.media.update(id, changes, options?)` | `MediaItem` |
| `client.media.updateMany(items, options?)` | `{ items, updated, skipped }` |
| `client.media.delete(id, options?)` | `{ message }` |
| `client.media.deleteMany(ids, options?)` | `{ deleted }` |
| `client.media.filters(options?)` | `{ contentTypes, types, exts }` |
| `client.media.stats(options?)` | `{ total, types }` |

All methods return unwrapped business data and throw on failure. You can pass a `signal` through `options`. Listing supports `search`, `contentType`, `type`, `ext`, `fileName`, `sort`, and `order`. The `sort` values are `newest | oldest | fileName`, and `order` is `asc | desc`. The server currently searches filenames only. The `limit` is 1–100 and `offset` starts at 0. Batch updates and deletions accept 1–100 items per request and are not automatically split. Batch results preserve the server's processing counts; check `skipped` when updating items.

```ts
await client.media.updateMany([
  { id: firstId, fileName: 'a.png' },
  { id: secondId, extra: { description: 'Screenshot' } },
])
await client.media.deleteMany([firstId, secondId])
```

Media fields retain their server names: `id`, `imgUrl`, `fileName`, `type`, `contentType`, `size`, `width`, `height`, `extname`, `createdAt`, `updatedAt`, `originImgUrl`, `url`, and `extra`. Timestamps are in milliseconds. Updates change media metadata, not the stored file contents; `size` and `extname` cannot be updated. Deletion is a server-side soft delete, and there is currently no restore API.

## Error handling

```ts
import { PicGoCloudError } from '@picgo/cloud-sdk'

try {
  await client.upload(file)
} catch (error) {
  if (error instanceof PicGoCloudError) {
    console.log(error.kind, error.status, error.code)
    if (error.status === 401) showTokenInput()
  } else {
    throw error
  }
}
```

`PicGoCloudError` includes the error `kind`, optional HTTP `status`, server `code`, and original `cause`. Some server errors have no code; use the status as a fallback. The SDK does not branch on error messages or automatically clear the user's token. Browsers may report CORS rejections as ordinary network errors, so check both the API and R2 CORS configurations when troubleshooting.

## Server requirements

The SDK does not bypass browser CORS. The companion picgo-hub branch, `feat-cloud-sdk`, enables third-party Bearer CORS for the SDK's endpoints while preserving Portal cookies and the OAuth callback allowlist. The R2 bucket must allow PUT requests from third-party origins and the headers required by signing, and expose `ETag` through `ExposeHeaders`. See the hub SDK CORS documentation for configuration and deployment verification. Source changes alone do not update production configuration.

Business requests always go to the configured API. Production R2 transfers do not include the account token. For local development, Bearer authentication is added only to recognized Worker upload proxy paths on the same localhost/127.0.0.1 origin as the API.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs type checking, ESLint, Vitest, and the build. Output includes `dist/index.js`, a source map, and type declarations. The package is ESM-only and contains no Node polyfills. After running `pnpm build`, serve `examples/basic.html` with a local static server for a native browser example. Its token stays in page memory.

To verify the protocol in a real browser, run `pnpm build && pnpm test:browser:serve` and open `http://localhost:41780`. This local test uses three different origins to simulate the page, API, and storage. It checks real CORS preflights, XHR progress, ETag access, media management, and recovery from registration failure after multipart completion. It does not access real accounts or write to cloud storage. The page displays `passed: true` on success. Stop the server with Ctrl+C, and restart it before each new test to reset the simulated state.
