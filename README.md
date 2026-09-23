# @picgo/cloud-sdk

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
  baseUrl: 'https://api.picgo.app', // 默认值；本地开发可指向 Worker
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

小于 10 MiB 使用单次预签名 PUT，大于等于 10 MiB 自动分片。分片大小使用服务端返回值，默认并发 3，可通过 `concurrency` 设置为 1–6。SDK 接受 1 byte–1 GiB，实际文件格式、类型大小限制、套餐和配额仍由服务端校验。不转换、压缩或重新编码文件。可通过 `width`、`height` 提供图片尺寸。

`phase` 为 `preparing`、`uploading`、`completing`、`completed`。`fraction` 仅表示文件传输比例，传输达到 100% 后还有合并和媒体入库步骤；只有 Promise 成功返回才代表上传完成。重试时传输进度可能回退。进度回调抛出的异常不会改变上传结果。

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

`createUpload()` 不立即发送请求。`start()` 开始上传；正在运行时重复调用会返回同一个 Promise。`pause()` 中断当前请求，当前 Promise 以 `kind: 'paused'` 拒绝；等待它结束后再次 `start()` 继续。`cancel()` 中断并清理未完成的分片会话，任务取消后需新建任务。清理请求失败会向调用方报告，保留记录以便再次尝试。取消不回滚已成功入库的媒体；已经传完但未入库的对象由服务端清理策略处理。

`task.status` 可读取 `idle`、`running`、`paused`、`cancelled`、`failed`、`completed`。如应用已有 AbortController，可选传入 `signal`；外部 signal 中断会保留续传信息，不等同于 `cancel()` 的服务端清理。已经中断的外部 signal 不能用于重新开始，应创建新任务。

### 断点续传

分片上传默认将会话及已完成分片的 ETag 写入当前站点的 localStorage，缓存有效期 24 小时。刷新页面后重新选择原文件，再调用 `upload()` 或 `createUpload().start()`，会自动恢复。SDK 以分块内容摘要识别文件，内存占用不随整个文件大小增长；准备阶段会读取文件内容。记录按 API 地址、账户和文件隔离，不包含 token、预签名 URL 或原始文件。

新 Worker 的 `whoami.userId` 用于账户隔离，同一账户更换 token 后仍可恢复；旧 Worker 没有该字段时使用 token 摘要隔离，更换 token 后不会命中旧记录。同一任务不允许切换账户。Web Locks 可用时阻止跨标签页同时恢复同一文件；不支持 Web Locks 时只提供当前页面内的互斥。

续传需要当前站点仍保留本地记录、用户提供同一文件，且服务端会话尚未失效；不支持跨站点或跨设备恢复。浏览器存储不可用时自动降级为任务内存中的续传。`storage: false` 关闭持久化，`resume: false` 让该次上传忽略持久化记录。小文件不提供跨刷新续传，但同一任务入库失败后重试不会重复 PUT。分片上传会保留已合并待入库状态，直到入库成功才清除记录。

SDK 只重试可安全重试的步骤，分片 PUT 使用最多 3 次额外重试和 1/2/4 秒退避，403 时重新获取签名 URL。媒体更新、删除及新建上传会话不会被静默重试。丢失分片合并响应时，优先尝试幂等的媒体入库以确认是否已经合并，避免直接创建另一份上传。

## 媒体管理

PicGo Cloud 当前的“相册”是媒体条目列表，没有相册分组实体。`media` 对应 `/api/album-items`，不使用已弃用的 `/api/media`，不提供第三方图床记录导入。

| 方法 | 返回值 |
| --- | --- |
| `client.whoami(options?)` | 当前用户资料，含新版服务端的 `userId` |
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

媒体字段沿用服务端命名，包括 `id`、`imgUrl`、`fileName`、`type`、`contentType`、`size`、`width`、`height`、`extname`、`createdAt`、`updatedAt`、`originImgUrl`、`url`、`extra`，时间戳为毫秒。更新修改媒体元数据，不修改存储中的文件内容；不允许更新 `size`、`extname`。删除是服务端软删除，目前没有恢复接口。

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

`PicGoCloudError` 包含错误类别 `kind`、可选 HTTP `status`、后端 `code` 和原始 `cause`。服务端部分错误没有 code，可按状态码兜底。SDK 不根据错误文案决定行为，不自动清除用户 token。浏览器可能把 CORS 拒绝表现为普通网络错误；诊断时检查 API 和 R2 两处跨域配置。

## 服务端接入条件

SDK 不会绕过浏览器跨域。配套 picgo-hub 分支 `feat-cloud-sdk` 为 SDK 使用的端点增加第三方 Bearer CORS，同时保留 Portal Cookie 和 OAuth 回调白名单。R2 Bucket 必须允许第三方 Origin 的 PUT、签名所需请求头，并通过 `ExposeHeaders` 暴露 `ETag`。具体配置及部署验证步骤见 hub 的 SDK CORS 文档。修改源码不代表线上配置已生效。

业务请求始终发送给配置的 API。生产 R2 直传不携带账户 token；仅 localhost/127.0.0.1 的同源、已知 Worker 上传代理路径会添加 Bearer 以支持本地开发。

## 开发

```sh
pnpm install
pnpm check
```

`pnpm check` 运行类型检查、ESLint、Vitest 和构建。产物为 `dist/index.js`、sourcemap 及类型声明，仅发布 ESM，无 Node polyfill。`examples/basic.html` 是可搭配本地静态服务器使用的原生浏览器示例，先执行 `pnpm build`；其中的 token 只保留在页面内存中。

真实浏览器协议验证可运行 `pnpm build && pnpm test:browser:serve`，然后访问 `http://localhost:41780`。这个本地测试使用三个不同 Origin 模拟网页、API 和存储，检查真实 CORS 预检、XHR 进度、ETag、媒体管理以及合并后入库失败的恢复，不会访问真实账户或写入云端。页面显示 `passed: true` 代表通过，终端 Ctrl+C 停止服务。每次重新测试前重启测试服务，以重置模拟状态。
