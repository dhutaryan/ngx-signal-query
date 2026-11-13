import {
  type Observable,
  defer,
  retry as retryOperator,
  tap,
  timer,
} from 'rxjs'

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

/** @internal */
export interface RetryerConfig<T, TError> {
  // Makes an attempt; called again for each retry. The index counts the
  // attempts made before this one: 0 for the first.
  attempt: (attemptIndex: number) => Observable<T>
  retry: RetryValue<TError>
  retryDelay: RetryDelayValue<TError>
  // Each failed attempt as it comes in, the last one included.
  onFail: (failureCount: number, error: TError) => void
  // Whether a failure ends the attempts at once: asked when one comes in,
  // and again once the wait for the retry is over.
  stopped?: () => boolean
}

// Makes the attempts of a fetch or a run until one succeeds, retrying a
// failure as `retry` allows, after the wait `retryDelay` gives.
/** @internal */
export function retryer<T, TError>({
  attempt,
  retry,
  retryDelay,
  onFail,
  stopped = () => false,
}: RetryerConfig<T, TError>): Observable<T> {
  let attemptIndex = 0

  return defer(() => attempt(attemptIndex++)).pipe(
    retryOperator({
      delay: (error: TError, retryCount) => {
        // retryCount (1-based) is the number of failures so far. Counted
        // first: the failure that ends the attempts counts too.
        onFail(retryCount, error)

        // `retry` and `retryDelay` get the number of retries made so far: 0
        // when the first retry is to be decided.
        const retriesMade = retryCount - 1

        if (stopped() || !shouldRetry(retry, retriesMade, error)) throw error

        // The retry goes out when the wait is over, unless the attempts were
        // stopped meanwhile: an error thrown when the timer fires ends them
        // with this failure instead.
        return timer(resolveRetryDelay(retryDelay, retriesMade, error)).pipe(
          tap(() => {
            if (stopped()) throw error
          }),
        )
      },
    }),
  )
}
