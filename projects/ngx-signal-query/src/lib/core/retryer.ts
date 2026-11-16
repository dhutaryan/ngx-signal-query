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

// The failure fields of a query's fetch or a mutation's run that ends with
// `error`. Each failed attempt is counted when it comes in, the last one
// included (see RetryerConfig.onFail). So when the fetch or run ends with the
// failure of its last attempt, that failure is already the failureReason and
// isn't counted again. A response that one of the caller's checks rejects is
// such a failure too (see RetryerConfig.final). Any other failure counts one
// more: an onMutate that throws before the attempts, or a failure found after
// them, such as a structuralSharing function that throws or a mutationFn
// whose Observable completes without a value. The count is checked as well
// because an error can be null, and failureReason is null until a failure is
// counted.
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
  // Whether a failure ends the attempts at once: asked when one that isn't
  // final comes in, and again once the wait for the retry is over.
  stopped?: () => boolean
  // Whether a failure is one that another attempt would only bring again,
  // such as a response that one of the caller's checks rejects. Such a
  // failure is counted and ends the attempts at once: neither `stopped` nor
  // `retry` is asked about it. Only the caller can tell which failures are
  // final: the same error object can reach the attempts of another fetch or
  // of a mutation, through a function that passes it on, and there it is
  // retried like any other failure.
  final?: (error: TError) => boolean
}

// Makes the attempts of a fetch or a run until one succeeds, retrying a
// failure as `retry` allows, after the wait `retryDelay` gives. A final
// failure ends them at once.
/** @internal */
export function retryer<T, TError>({
  attempt,
  retry,
  retryDelay,
  onFail,
  stopped = () => false,
  final = () => false,
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

        // A final failure first: nothing else is asked about it.
        if (
          final(error) ||
          stopped() ||
          !shouldRetry(retry, retriesMade, error)
        ) {
          throw error
        }

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
