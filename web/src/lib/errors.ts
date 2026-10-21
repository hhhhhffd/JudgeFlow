import { ApiError } from '@/api/client'
import { ru } from '@/i18n/ru'

/** Human text for any thrown value; server messages are already Russian. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? ru.common.networkError : e.message
  return ru.common.unknownError
}
