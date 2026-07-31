import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query('telegramChats').collect(),
})

export const register = mutation({
  args: {
    key: v.string(),
    chatId: v.number(),
    firstName: v.optional(v.string()),
    username: v.optional(v.string()),
  },
  handler: async (ctx, { key, chatId, firstName, username }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('telegramChats')
      .withIndex('by_chat', (q) => q.eq('chatId', chatId))
      .unique()
    if (row) {
      await ctx.db.patch(row._id, { lastSeenAt: Date.now(), firstName, username, muted: false })
      return row._id
    }
    return await ctx.db.insert('telegramChats', {
      chatId,
      firstName,
      username,
      muted: false,
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    })
  },
})

export const setMuted = mutation({
  args: { key: v.string(), chatId: v.number(), muted: v.boolean() },
  handler: async (ctx, { key, chatId, muted }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('telegramChats')
      .withIndex('by_chat', (q) => q.eq('chatId', chatId))
      .unique()
    if (row) await ctx.db.patch(row._id, { muted })
    return true
  },
})
