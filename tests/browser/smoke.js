import { PicGoCloudClient } from '/dist/index.js'

function assert(condition, message) { if (!condition) throw new Error(message) }

async function run() {
  document.cookie = 'should-not-leak=1; SameSite=Lax; Path=/'
  localStorage.clear()
  const options = { token: 'browser-smoke-token', baseUrl: 'http://localhost:41781' }
  const client = new PicGoCloudClient(options)
  const progress = []
  const small = await client.upload(new File(['png'], 'small.png', { type: 'image/png' }), {
    onProgress: event => progress.push(event),
  })
  assert(small.id === '1', 'small upload result')
  assert(small.url === 'https://media.example/1.png', 'upload provides a media URL')
  const largeFile = new File([new Uint8Array(10 * 1024 * 1024)], 'large.png', { type: 'image/png' })
  let failedRegistration = false
  try { await client.upload(largeFile) }
  catch (error) { failedRegistration = error.code === 'TEST_REGISTRATION_FAILURE' }
  assert(failedRegistration, 'registration error must reach the caller')
  assert(localStorage.length > 0, 'merged session must remain persisted')
  const recreated = new PicGoCloudClient(options)
  const large = await recreated.upload(largeFile)
  assert(large.id === '2', 'recreated client should register the existing object')
  assert(localStorage.length === 0, 'successful registration clears the session')
  const page = await client.media.list()
  assert(page.total === 2, 'list result')
  assert(page.items.every(item => typeof item.url === 'string'), 'every listed item provides a URL')
  assert((await client.media.update(small.id, { fileName: 'renamed.png' })).fileName === 'renamed.png', 'update result')
  await client.media.delete(small.id)
  assert((await client.media.list()).total === 1, 'delete result')
  const counts = await fetch(`${options.baseUrl}/counts`, { credentials: 'omit', headers: { Authorization: `Bearer ${options.token}` } }).then(response => response.json())
  assert(counts.puts === 3, 'one single PUT and two parts; recovery must not upload again')
  assert(counts.merges === 1, 'one multipart merge')
  assert(counts.preflights > 0, 'browser performed real CORS preflights')
  assert(counts.credentialsLeaked === 0, 'cookies/token leaked into a storage request')
  assert(progress.some(event => event.phase === 'uploading'), 'real XHR progress received')
  assert(progress.at(-1).phase === 'completed', 'last progress follows registration')
  return { passed: true, counts, progressEvents: progress.length, recoveredMediaId: large.id }
}

const result = document.getElementById('result')
const execution = run()
execution.then(value => {
  result.dataset.status = 'passed'
  result.textContent = JSON.stringify(value, null, 2)
}, error => {
  result.dataset.status = 'failed'
  result.textContent = `${error.stack}`
})
