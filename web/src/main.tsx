import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRoutes } from '@/app/routes'
import { Providers } from '@/app/providers'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <AppRoutes />
    </Providers>
  </StrictMode>,
)

// Offline app shell for the Judge Desk (SPEC §9). Service workers need a secure context
// (HTTPS or localhost); on plain-HTTP LAN origins the app just runs without offline reloads.
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('Service worker registration failed', e))
  })
}
