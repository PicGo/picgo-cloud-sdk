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
  baseUrl: 'https://api.picgo.app', // Default PicGo Cloud API URL
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

The SDK chooses the upload method automatically. Files at or above 10 MiB support multipart uploads, with a default concurrency of 3; set `concurrency` to a value from 1–6 to adjust it. Accepted files are between 1 byte and 1 GiB, subject to your PicGo Cloud plan, remaining quota, and supported file formats. Files are not converted, compressed, or re-encoded. Use `width` and `height` to supply image dimensions.

The `phase` is `preparing`, `uploading`, `completing`, or `completed`. The `fraction` measures transfer progress: reaching 100% does not mean the file is ready to use yet. Wait for the Promise to resolve before using the returned media item. Transfer progress can decrease during retries. Exceptions thrown by progress callbacks do not affect the upload result.

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

`createUpload()` does not send requests immediately. Call `start()` to begin; repeated calls while it is running return the same Promise. `pause()` interrupts the upload and rejects that Promise with `kind: 'paused'`; once it settles, call `start()` again to continue. `cancel()` stops the upload and releases its pending resources. If it fails, you can call it again. Create a new task after cancellation. Cancelling does not delete an already completed media item; use `client.media.delete()` for that.

The `task.status` is `idle`, `running`, `paused`, `cancelled`, `failed`, or `completed`. If your application already uses an AbortController, you can pass its `signal`. Aborting an external signal retains recovery information; use `cancel()` to abandon the upload. An already-aborted external signal cannot be reused to restart an upload; create a new task.

### Resumable uploads

Multipart uploads save recovery information in the current site's localStorage for up to 24 hours. After refreshing the page, select the same file and call `upload()` or `createUpload().start()` to resume automatically. Recovery records are isolated by account and file and contain no tokens or file contents. Keep the same account and API URL when resuming.

Recovery is limited to the same site and browser, while the saved upload remains valid. It does not work across sites or devices. If browser storage is unavailable, you can still pause and resume the current task while the page remains open. Set `storage: false` on the client to disable persistence, or `resume: false` in upload options to ignore persisted records. If a file smaller than 10 MiB is paused during transfer, resuming restarts that transfer. Avoid uploading the same file from multiple tabs at once.

Temporary upload failures are retried automatically when safe. If a task fails, catch the error and call `start()` again to retry. Media updates and deletions are not automatically retried.

## Media management

Use `client.media` to browse and manage the media in the user's PicGo Cloud account.

| Method | Returns |
| --- | --- |
| `client.whoami(options?)` | Current user details; also verifies the supplied token |
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

`MediaItem` includes `id`, `imgUrl`, and optional metadata such as `fileName`, `type`, `contentType`, `size`, `width`, `height`, `extname`, `createdAt`, `updatedAt`, `originImgUrl`, `url`, and `extra`. Timestamps are in milliseconds. Updates change metadata, not the file contents; `size` and `extname` cannot be updated. Deleted items disappear from the media list. The SDK does not provide a restore operation.

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

`PicGoCloudError` includes the error `kind`, optional HTTP `status`, service `code`, and original `cause`. Use `kind`, `status`, and `code` for application logic rather than matching error messages. A 401 usually means the user needs to provide a valid token. For network errors, check connectivity and the configured API URL. The SDK does not automatically clear the user's token.

## Try the example locally

Clone this repository and use Node.js 22.18+ (Node.js 24 recommended). Copy `.env.example` to `.env`:

```dotenv
PICGO_API_URL=https://api.picgo.app
PICGO_DEV_PORT=5175
```

```sh
pnpm install
pnpm dev
```

Open `http://localhost:5175` and enter your PicGo Cloud token. The example lets you verify the token, upload files, pause/resume/cancel uploads, and list, inspect, rename, or delete media. Uploaded items automatically populate the media ID field for follow-up operations. These actions affect the account associated with your token.

Start by verifying the token, then upload a file smaller than 10 MiB and one at or above 10 MiB. Test pausing and resuming a multipart upload, and refresh the page and reselect the same file to test recovery. Use the media buttons to verify that the uploaded item's metadata can be read, renamed, and deleted. If a fast connection makes interruption difficult, throttle the network in browser developer tools.

You can change `PICGO_API_URL` to test another PicGo Cloud API endpoint; restart `pnpm dev` after editing `.env`. Existing shell environment variables take precedence. Source changes rebuild automatically; refresh the page to load them. `.env` is ignored by Git, and the token stays in page memory. These environment settings apply only to the example. In your own application, pass `baseUrl` to `PicGoCloudClient` when overriding the default URL.
