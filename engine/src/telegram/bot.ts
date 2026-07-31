/**
 * Telegram transport: outbound cards + inbound command long-polling.
 * Deliberately dependency-free (fetch only) and resilient: a Telegram outage
 * never blocks the decision loop.
 */
import { log } from '../log.js'

export interface TelegramMessage {
  chatId: number
  html: string
}

export interface CommandContext {
  chatId: number
  from: { id: number; firstName?: string; username?: string }
  command: string
  args: string[]
  raw: string
}

export type CommandHandler = (ctx: CommandContext) => Promise<string | null>

export class TelegramBot {
  private offset = 0
  private polling = false
  private lastSendAt = 0
  sent = 0
  failed = 0
  received = 0
  lastError = ''
  me: { id: number; username: string } | null = null

  constructor(private token: string) {}

  get configured() {
    return Boolean(this.token)
  }

  setToken(token: string) {
    this.token = token
    this.me = null
  }

  private url(method: string) {
    return `https://api.telegram.org/bot${this.token}/${method}`
  }

  private async call<T>(method: string, body?: unknown, timeoutMs = 15_000): Promise<T | null> {
    if (!this.token) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.url(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
      if (!json.ok) {
        this.lastError = json.description ?? `HTTP ${res.status}`
        return null
      }
      return json.result ?? null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async identify() {
    const me = await this.call<{ id: number; username: string }>('getMe')
    if (me) this.me = { id: me.id, username: me.username }
    return this.me
  }

  /** Telegram allows ~30 msg/s globally but 1/s per chat — stay polite. */
  async send(chatId: number, html: string) {
    const wait = Math.max(0, 1100 - (Date.now() - this.lastSendAt))
    if (wait) await new Promise((r) => setTimeout(r, wait))
    this.lastSendAt = Date.now()
    const res = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: html.slice(0, 4090),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    if (res) {
      this.sent++
      return true
    }
    this.failed++
    log.error('telegram', `send failed: ${this.lastError}`)
    return false
  }

  async broadcast(chatIds: number[], html: string) {
    let delivered = 0
    for (const id of chatIds) if (await this.send(id, html)) delivered++
    return delivered
  }

  /** Drain pending updates without acting on them (used at boot). */
  async syncOffset() {
    const updates = await this.call<{ update_id: number }[]>('getUpdates', { timeout: 0 })
    if (updates?.length) this.offset = updates[updates.length - 1].update_id + 1
    return this.offset
  }

  startPolling(handler: CommandHandler) {
    if (this.polling || !this.token) return
    this.polling = true
    const loop = async () => {
      while (this.polling) {
        const updates = await this.call<
          {
            update_id: number
            message?: {
              chat: { id: number }
              text?: string
              from?: { id: number; first_name?: string; username?: string }
            }
          }[]
        >('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, 40_000)

        if (!updates) {
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }
        for (const u of updates) {
          this.offset = u.update_id + 1
          const text = u.message?.text?.trim()
          if (!text || !u.message) continue
          this.received++
          const [rawCmd, ...args] = text.split(/\s+/)
          const command = rawCmd.replace(/^\//, '').split('@')[0].toLowerCase()
          try {
            const reply = await handler({
              chatId: u.message.chat.id,
              from: {
                id: u.message.from?.id ?? u.message.chat.id,
                firstName: u.message.from?.first_name,
                username: u.message.from?.username,
              },
              command,
              args,
              raw: text,
            })
            if (reply) await this.send(u.message.chat.id, reply)
          } catch (err) {
            await this.send(
              u.message.chat.id,
              `\u{26A0} <b>Command failed</b>\n<code>${(err instanceof Error ? err.message : String(err)).slice(0, 300)}</code>`,
            )
          }
        }
      }
    }
    void loop()
  }

  stop() {
    this.polling = false
  }

  stats() {
    return {
      configured: this.configured,
      username: this.me?.username ?? '',
      sent: this.sent,
      failed: this.failed,
      received: this.received,
      lastError: this.lastError,
      polling: this.polling,
    }
  }
}
