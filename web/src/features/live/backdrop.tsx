import type { Overlay } from '@/api/types'

const HEX = /^#[0-9a-fA-F]{3,8}$/

/** Fixed full-screen event background with an optional colour overlay. Content must sit above it (relative z-10). */
export function Backdrop({ url, overlay }: { url: string | null; overlay: Overlay }) {
  const color = HEX.test(overlay.color) ? overlay.color : '#000000'
  const opacity = Math.min(100, Math.max(0, overlay.opacity)) / 100
  return (
    <div aria-hidden className="fixed inset-0 z-0 bg-background">
      {url && <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${JSON.stringify(url)})` }} />}
      {url && overlay.enabled && <div className="absolute inset-0" style={{ backgroundColor: color, opacity }} />}
    </div>
  )
}
