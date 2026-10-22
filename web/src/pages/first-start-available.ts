import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { setupApi } from '@/api/endpoints'

/** True while no admin exists yet (the status endpoint answers 404 once setup is done). */
export function useFirstStartAvailable() {
  return useQuery({
    queryKey: ['first-start'],
    queryFn: async () => {
      try {
        await setupApi.checkFirstStart()
        return true
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return false
        throw e
      }
    },
    retry: false,
  })
}
