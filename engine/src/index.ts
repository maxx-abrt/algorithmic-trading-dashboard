/**
 * APEX-02 / MYCROFT — engine entry point.
 * Boots the runtime loops, then exposes the HTTP API for the dashboard.
 */
import './env.js'
import { log } from './log.js'
import { runtime } from './runtime.js'
import { startServer } from './server.js'

async function main() {
  const server = startServer()
  await runtime.boot()

  const shutdown = async (signal: string) => {
    log.info('shutdown', `received ${signal}`)
    runtime.stop()
    await log.flush()
    server.close()
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled', reason instanceof Error ? reason.message : String(reason))
  })
  process.on('uncaughtException', (err) => {
    log.error('uncaught', err.message)
  })
}

void main()
