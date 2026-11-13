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

// The failure fields of a fetch or a run that ends with `error`. The retries
// count each failed attempt as it happens, the last one included, so the
// failure they saw last is the failureReason already and isn't counted
// twice. Any other failure is one more: one found once the response is in
// (an Observable that completes empty, undefined, a structuralSharing
// function that throws), or an onMutate that throws. Until a failure is
// counted, failureReason is null, and an error may be null too: hence the
// check on the count.
/** @internal */
export function countFailure<TError>(
  state: { failureCount: number; failureReason: TError | null },
  error: TError,
): { failureCount: number; failureReason: TError } {
  return {
    failureCount:
      state.failureCount > 0 && error === state.failureReason
        ? state.failureCount
        : state.failureCount + 1,
    failureReason: error,
  }
}
