# @picgo/cloud-sdk

[English](README.md)

面向现代浏览器的 PicGo Cloud JavaScript SDK，使用 TypeScript 编写、Rolldown 构建，零运行时依赖。提供文件上传、分片续传和媒体管理，不包含 UI 组件。Node.js 场景请使用 PicGo-Core。

## 安装与使用

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

const page = await client.media.list({ limit: 20, offset: 0, search: '旅行' })
await client.media.update(media.id, { fileName: '旅行照片.jpg' })
await client.media.delete(media.id)
```

token 由使用网页的用户提供，代表该用户的账户权限。SDK 使用 `Authorization: Bearer`，不携带 Cookie，也不默认保存或打印 token。不要将站点开发者自己的 token 写进公开的前端构建产物。支持直接传入字符串，也支持 `token: () => currentToken` 或异步获取函数；每轮上传固定使用同一个 token，避免分片过程中混用账户。

```ts
const client = new PicGoCloudClient({
  token: async () => getCurrentUserToken(),
  baseUrl: 'https://api.picgo.app', // 默认 PicGo Cloud API 地址
  timeoutMs: 30_000, // 单次 API 请求超时
  uploadTimeoutMs: 120_000, // 单次文件/分片 PUT 超时
  // storage: false, // 可关闭续传记录持久化
})
```

API 使用原生 fetch，可通过 `fetch` 选项注入自定义实现。上传字节使用原生 XMLHttpRequest 以提供浏览器上传进度，不经过自定义 fetch。模块导入本身不访问 DOM；实际上传需要浏览器的 Blob/File、XMLHttpRequest、Web Crypto 和 AbortSignal.any，建议在 HTTPS 或 localhost 安全上下文使用。

## 上传

```ts
const media = await client.upload(file, {
  onProgress({ phase, loaded, total, fraction, resumed }) {
    console.log(phase, loaded, total, fraction, resumed)
  },
})

// Blob 没有文件名，需要显式指定。
await client.upload(blob, { filename: 'photo.png', contentType: 'image/png' })
```

SDK 会自动选择上传方式，大于等于 10 MiB 的文件支持分片上传。默认并发 3，可通过 `concurrency` 设置为 1–6。支持的文件大小为 1 byte–1 GiB，实际可上传的格式和大小还取决于你的 PicGo Cloud 套餐及剩余配额。文件不会被转换、压缩或重新编码。可通过 `width`、`height` 提供图片尺寸。

`phase` 为 `preparing`、`uploading`、`completing`、`completed`。`fraction` 表示传输进度，达到 100% 不代表文件已经可以使用；请等待 Promise 成功返回后再使用媒体条目。重试时进度可能回退。进度回调抛出的异常不会改变上传结果。

### 暂停、继续与取消

```ts
import { PicGoCloudError } from '@picgo/cloud-sdk'

const task = client.createUpload(file, { onProgress: updateProgress })

pauseButton.addEventListener('click', () => task.pause())
cancelButton.addEventListener('click', async () => {
  try {
    await task.cancel()
  } catch (error) {
    showError(error) // 网络失败时可再次调用 cancel() 重试清理
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

`createUpload()` 不立即发送请求。调用 `start()` 开始上传，正在运行时重复调用会返回同一个 Promise。`pause()` 中断上传，当前 Promise 以 `kind: 'paused'` 拒绝；等待它结束后再次调用 `start()` 继续。`cancel()` 停止上传并释放未完成任务的资源，失败时可以再次调用。取消后需新建任务。取消不会删除已经上传成功的媒体，删除请使用 `client.media.delete()`。

`task.status` 可读取 `idle`、`running`、`paused`、`cancelled`、`failed`、`completed`。如应用已有 AbortController，可选传入 `signal`。外部 signal 中断会保留续传信息；要放弃上传，请使用 `cancel()`。已经中断的外部 signal 不能用于重新开始，应创建新任务。

### 断点续传

分片上传会在当前站点的 localStorage 中保存最多 24 小时的恢复信息。刷新页面后重新选择同一文件，再调用 `upload()` 或 `createUpload().start()`，即可自动恢复。恢复记录按账户和文件隔离，不包含 token 或文件内容。续传时请保持同一账户和 API 地址。

恢复仅适用于同一站点、同一浏览器中仍有效的上传记录，不支持跨站点或跨设备恢复。浏览器存储不可用时，页面保持打开期间仍可暂停和继续当前任务。在客户端设置 `storage: false` 可关闭持久化，在上传选项中设置 `resume: false` 可忽略已有记录。小于 10 MiB 的文件若在传输过程中暂停，继续时会重新传输。请避免在多个标签页同时上传同一文件。

临时上传失败会在安全的情况下自动重试。任务失败后，可以捕获错误并再次调用 `start()` 重试。媒体更新和删除不会自动重试。

## 媒体管理

使用 `client.media` 浏览和管理用户 PicGo Cloud 账户中的媒体。

| 方法 | 返回值 |
| --- | --- |
| `client.whoami(options?)` | 当前用户资料，也可用于验证 token |
| `client.media.list(query?, options?)` | `{ items, total, limit, offset }` |
| `client.media.get(id, options?)` | `MediaItem` |
| `client.media.update(id, changes, options?)` | `MediaItem` |
| `client.media.updateMany(items, options?)` | `{ items, updated, skipped }` |
| `client.media.delete(id, options?)` | `{ message }` |
| `client.media.deleteMany(ids, options?)` | `{ deleted }` |
| `client.media.filters(options?)` | `{ contentTypes, types, exts }` |
| `client.media.stats(options?)` | `{ total, types }` |

所有接口返回解包后的业务数据，失败则抛异常。`options` 可传 `signal`。列表支持 `search`、`contentType`、`type`、`ext`、`fileName`、`sort` 和 `order`，`sort` 为 `newest | oldest | fileName`，`order` 为 `asc | desc`。当前服务端 `search` 仅搜索文件名。`limit` 为 1–100，`offset` 从 0 开始；批量更新和删除每次 1–100 条，不自动拆批。批量结果保留后端处理数量，请检查 `skipped`。

```ts
await client.media.updateMany([
  { id: firstId, fileName: 'a.png' },
  { id: secondId, extra: { description: '截图' } },
])
await client.media.deleteMany([firstId, secondId])
```

`MediaItem` 包含 `id`、`imgUrl`，以及可选的 `fileName`、`type`、`contentType`、`size`、`width`、`height`、`extname`、`createdAt`、`updatedAt`、`originImgUrl`、`url`、`extra` 等元数据。时间戳为毫秒。更新修改元数据，不修改文件内容；不允许更新 `size`、`extname`。删除后条目将不再出现在媒体列表中，SDK 不提供恢复操作。

## 错误处理

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

`PicGoCloudError` 包含错误类别 `kind`、可选 HTTP `status`、服务错误码 `code` 和原始 `cause`。请根据 `kind`、`status`、`code` 处理错误，不要匹配错误文案。401 通常表示需要用户提供有效的 token。遇到网络错误时，检查网络连接和配置的 API 地址。SDK 不会自动清除用户 token。

## 本地试用示例

克隆本仓库，使用 Node.js 22.18+，推荐 Node.js 24。将 `.env.example` 复制为 `.env`：

```dotenv
PICGO_API_URL=https://api.picgo.app
PICGO_DEV_PORT=5175
```

```sh
pnpm install
pnpm dev
```

打开 `http://localhost:5175`，输入你的 PicGo Cloud token。示例页支持验证 token、上传、暂停/继续/取消、媒体列表、详情、重命名和删除。上传成功后会自动填写媒体 ID，方便继续操作。这些操作会作用于 token 所属账户的媒体数据。

建议先验证 token，再分别上传小于 10 MiB 和大于等于 10 MiB 的文件。对分片上传测试暂停与继续，再刷新页面、重新选择同一文件测试恢复。通过媒体操作按钮验证上传后的条目能查询、重命名和删除。网速太快不方便中断时，可在浏览器开发者工具中启用网络限速。

可以修改 `PICGO_API_URL` 来测试其他 PicGo Cloud API 地址，修改 `.env` 后需重启 `pnpm dev`。已有的 shell 环境变量优先于 `.env`。修改源码后会自动重新构建，刷新页面即可加载。`.env` 已被 Git 忽略，token 仅保留在页面内存中。这些环境设置只作用于示例页；在自己的应用中覆盖默认 API 地址时，请向 `PicGoCloudClient` 传入 `baseUrl`。
