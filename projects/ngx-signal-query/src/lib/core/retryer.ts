import type { RetryDelayValue, RetryValue } from './types'

// Exponential backoff capped at 30s, matching TanStack's default.
/** @internal */
export function defaultRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** failureCount, 30000)
}

/** @internal */
export function shouldRetry<TError>(
  retry: RetryValue<TError>,
  failureCount: number,
  error: TError,
): boolean {
  if (typeof retry === 'function') return retry(failureCount, error)
  if (typeof retry === 'number') return failureCount < retry

  return retry
}

/** @internal */
export function resolveRetryDelay<TError>(
  retryDelay: RetryDelayValue<TError>,
  failureCount: number,
  error: TError,
): number {
  return typeof retryDelay === 'function'
    ? retryDelay(failureCount, error)
    : retryDelay
}
