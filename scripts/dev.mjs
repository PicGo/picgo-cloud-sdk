import { watch } from 'rolldown'
import buildConfig from '../rolldown.config.ts'
import { createDevServer, readDevConfig } from './dev-server.mjs'

const config = readDevConfig()
const server = createDevServer(config)
const watcher = watch(buildConfig)

watcher.on('event', async event => {
  if (event.code === 'BUNDLE_END') {
    await event.result.close()
    console.log('SDK rebuilt. Refresh the browser to use the latest build.')
  } else if (event.code === 'ERROR') {
    console.error(event.error)
    await event.result?.close()
  }
})

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Playground: http://localhost:${config.port}`)
  console.log(`Backend: ${config.apiUrl}`)
  console.log('Enter your token in the browser. Edit .env and restart to switch backends.')
})

async function shutdown() {
  server.close()
  server.closeAllConnections()
  await watcher.close()
}

server.on('error', async error => {
  console.error(error)
  process.exitCode = 1
  await shutdown()
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown)
