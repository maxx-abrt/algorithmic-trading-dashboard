import { Dashboard } from '@/components/dashboard'

// Secrets are read on the server only; the client just gets two booleans.
export default function Page() {
  const envOk = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    okx: Boolean(
      process.env.OKX_API_KEY &&
        process.env.OKX_API_SECRET &&
        process.env.OKX_API_PASSPHRASE,
    ),
  }

  return <Dashboard envOk={envOk} />
}
