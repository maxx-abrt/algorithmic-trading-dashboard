'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The dashboard always talks to the engine through the relative `/api` prefix.
 * Next rewrites it locally, the hosted ingress proxies it in preview — identical
 * code either way, and no hardcoded hostname anywhere.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Malformed response from /api${path}`)
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`
    throw new Error(message)
  }
  return body as T
}

export const post = <T,>(path: string, payload?: unknown) =>
  api<T>(path, { method: 'POST', body: payload ? JSON.stringify(payload) : undefined })

export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' })
export const patch = <T,>(path: string, payload?: unknown) =>
  api<T>(path, { method: 'PATCH', body: payload ? JSON.stringify(payload) : undefined })

export interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
  updatedAt: number
  refresh: () => Promise<void>
}

/** Poll an engine endpoint. Keeps the last good payload while refreshing. */
export function usePoll<T>(path: string | null, intervalMs = 4000): PollState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [updatedAt, setUpdatedAt] = useState(0)
  const alive = useRef(true)
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(async () => {
    const p = pathRef.current
    if (!p) return
    try {
      const next = await api<T>(p)
      if (!alive.current) return
      setData(next)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (!path) {
      setLoading(false)
      return
    }
    setLoading(true)
    void load()
    const id = setInterval(() => void load(), intervalMs)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [path, intervalMs, load])

  return { data, error, loading, updatedAt, refresh: load }
}

/** Flash helper: returns 'up' | 'down' | null for ~420ms after a value changes. */
export function useFlash(value: number | null | undefined) {
  const [dir, setDir] = useState<'up' | 'down' | null>(null)
  const prev = useRef<number | null>(null)
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return
    if (prev.current != null && value !== prev.current) {
      setDir(value > prev.current ? 'up' : 'down')
      const id = setTimeout(() => setDir(null), 420)
      prev.current = value
      return () => clearTimeout(id)
    }
    prev.current = value
  }, [value])
  return dir
}
