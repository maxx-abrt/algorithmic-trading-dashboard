import { mutation } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

/**
 * One-shot maintenance helpers. Used when migrating from the APEX-01 schema
 * (tables `positions` / `marketState` / old `settings` shapes) to APEX-02.
 */
export const wipe = mutation({
  args: { key: v.string(), tables: v.array(v.string()) },
  handler: async (ctx, { key, tables }) => {
    assertWorker(key)
    const report: Record<string, number> = {}
    for (const table of tables) {
      let deleted = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch = await ctx.db.query(table as never).take(400)
        if (!batch.length) break
        for (const row of batch) await ctx.db.delete(row._id)
        deleted += batch.length
        if (batch.length < 400) break
      }
      report[table] = deleted
    }
    return report
  },
})
