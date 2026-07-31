/**
 * Session awareness.
 *
 * OKX lists tokenized equity perpetuals (NVDA-USDT-SWAP, TSLA-USDT-SWAP, …)
 * that trade 24/7 even though the underlying cash equity does not. Liquidity,
 * spreads and gap risk are radically different outside US regular trading hours,
 * and a system that ignores that will happily hand you a 3am NVDA "breakout"
 * printed on 40k of volume. This module makes the engine aware of it.
 */

export type Session = 'RTH' | 'PRE' | 'AFTER' | 'CLOSED' | 'WEEKEND' | 'CRYPTO_24_7'

export interface SessionInfo {
  session: Session
  isEquity: boolean
  marketOpen: boolean
  /** minutes until the next open (0 when already open) */
  minutesToOpen: number
  /** minutes until the close (0 when closed) */
  minutesToClose: number
  /** 0..1 multiplier applied to conviction outside liquid hours */
  liquidityFactor: number
  note: string
}

/** US eastern DST window (2nd Sunday of March → 1st Sunday of November). */
function isUsDst(d: Date) {
  const y = d.getUTCFullYear()
  const march = new Date(Date.UTC(y, 2, 1))
  const secondSunday = 8 + ((7 - march.getUTCDay()) % 7)
  const start = Date.UTC(y, 2, secondSunday, 7)
  const nov = new Date(Date.UTC(y, 10, 1))
  const firstSunday = 1 + ((7 - nov.getUTCDay()) % 7)
  const end = Date.UTC(y, 10, firstSunday, 6)
  const t = d.getTime()
  return t >= start && t < end
}

export function sessionInfo(isEquity: boolean, now = new Date()): SessionInfo {
  if (!isEquity) {
    return {
      session: 'CRYPTO_24_7',
      isEquity: false,
      marketOpen: true,
      minutesToOpen: 0,
      minutesToClose: 0,
      liquidityFactor: 1,
      note: 'crypto market — continuous 24/7 liquidity',
    }
  }

  const dst = isUsDst(now)
  const openUtcMin = dst ? 13 * 60 + 30 : 14 * 60 + 30 // 09:30 ET
  const closeUtcMin = dst ? 20 * 60 : 21 * 60 // 16:00 ET
  const preUtcMin = openUtcMin - 330 // 04:00 ET
  const afterUtcMin = closeUtcMin + 240 // 20:00 ET

  const dow = now.getUTCDay()
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()

  if (dow === 0 || dow === 6) {
    const daysToMonday = dow === 6 ? 2 : 1
    return {
      session: 'WEEKEND',
      isEquity: true,
      marketOpen: false,
      minutesToOpen: daysToMonday * 1440 + openUtcMin - minutes,
      minutesToClose: 0,
      liquidityFactor: 0.35,
      note: 'US cash equity closed for the weekend — tokenized swap only, thin book and gap risk on Monday',
    }
  }

  if (minutes >= openUtcMin && minutes < closeUtcMin) {
    return {
      session: 'RTH',
      isEquity: true,
      marketOpen: true,
      minutesToOpen: 0,
      minutesToClose: closeUtcMin - minutes,
      liquidityFactor: 1,
      note: 'US regular trading hours — deepest liquidity for the underlying',
    }
  }
  if (minutes >= preUtcMin && minutes < openUtcMin) {
    return {
      session: 'PRE',
      isEquity: true,
      marketOpen: false,
      minutesToOpen: openUtcMin - minutes,
      minutesToClose: 0,
      liquidityFactor: 0.7,
      note: 'US pre-market — wider spreads, opening gap possible',
    }
  }
  if (minutes >= closeUtcMin && minutes < afterUtcMin) {
    return {
      session: 'AFTER',
      isEquity: true,
      marketOpen: false,
      minutesToOpen: 1440 - minutes + openUtcMin,
      minutesToClose: 0,
      liquidityFactor: 0.7,
      note: 'US after-hours — earnings reactions happen here, size down',
    }
  }
  return {
    session: 'CLOSED',
    isEquity: true,
    marketOpen: false,
    minutesToOpen: minutes < openUtcMin ? openUtcMin - minutes : 1440 - minutes + openUtcMin,
    minutesToClose: 0,
    liquidityFactor: 0.45,
    note: 'US cash equity closed — tokenized price can drift on low volume',
  }
}
