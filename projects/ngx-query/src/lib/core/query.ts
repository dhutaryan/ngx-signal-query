import { signal } from '@angular/core'
import {
  defer,
  from,
  Observable,
  retry as retryOperator,
  take,
  throwIfEmpty,
  timer,
  type Subscription,
} from 'rxjs'

import { QueryCache } from './query-cache'
import {
  defaultRetryDelay,
  resolveRetryDelay,
  shouldRetry,
} from './retryer'
import {
  QueryKey,
  QueryState,
  RetryDelayValue,
  RetryValue,
} from './types'

const DEFAULT_GC_TIME = 5 * 60 * 1000

export class Query<TData, TError = Error> {
  readonly #state = signal<QueryState<TData, TError>>({
    data: undefined,
    status: 'pending',
    error: null,
    isFetching: false,
    isInvalidated: false,
    failureCount: 0,
    failureReason: null,
    updatedAt: 0,
  })
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null
  #observers = 0
  #gcTime = DEFAULT_GC_TIME
  #gcTimer: ReturnType<typeof setTimeout> | null = null
  readonly #cache: QueryCache

  constructor(
    readonly key: QueryKey,
    readonly queryHash: string,
    cache: QueryCache,
  ) {
    this.#cache = cache
  }

  get observerCount(): number {
    return this.#observers
  }

  setGcTime(ms: number): void {
    this.#gcTime = ms
  }

  addObserver(): void {
    this.#observers++
    this.#clearGcTimer()
  }

  removeObserver(): void {
    if (this.#observers === 0) return

    this.#observers--

    // No observers left: cancel any in-flight fetch (nobody is waiting for it)
    // and schedule gc to dispose the query if no observer returns.
    if (this.#observers === 0) {
      this.cancel()
      this.#scheduleGc()
    }
  }

  fetch(
    queryFn: () => Observable<TData> | Promise<TData>,
    retry: RetryValue<TError> = 0,
    retryDelay: RetryDelayValue<TError> = defaultRetryDelay,
    cancelRefetch = false,
  ): void {
    if (this.#subscription && !this.#subscription.closed) {
      // Already in-flight: dedupe unless the caller explicitly wants a fresh
      // fetch (e.g. invalidate/refetch) — then cancel the old one and restart.
      if (!cancelRefetch) return
      this.cancel()
    }

    this.#state.update((state) => ({
      ...state,
      isFetching: true,
      failureCount: 0,
      failureReason: null,
    }))

    // defer + from: normalize Observable/Promise and re-invoke queryFn on each
    // retry (a Promise is one-shot, so retry must produce a fresh one).
    this.#subscription = defer(() => from(queryFn()))
      .pipe(
        take(1),
        retryOperator({
          delay: (error, retryCount) => {
            // retryCount (1-based) is the number of failures so far; the retry
            // predicate/delay take a 0-based attempt index (0 = first retry).
            this.#state.update((state) => ({
              ...state,
              failureCount: retryCount,
              failureReason: error as TError,
            }))

            const attemptIndex = retryCount - 1
            if (!shouldRetry(retry, attemptIndex, error as TError)) throw error
            return timer(
              resolveRetryDelay(retryDelay, attemptIndex, error as TError),
            )
          },
        }),
        throwIfEmpty(
          () => new Error('Query function completed without emitting a value'),
        ),
      )
      .subscribe({
        next: (data) =>
          this.#state.set({
            data,
            status: 'success',
            error: null,
            isFetching: false,
            isInvalidated: false,
            failureCount: 0,
            failureReason: null,
            updatedAt: Date.now(),
          }),
        error: (err) =>
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
          })),
      })
  }

  setData(data: TData): void {
    this.#state.update((state) => ({
      ...state,
      data,
      status: 'success',
      error: null,
      isInvalidated: false,
      failureCount: 0,
      failureReason: null,
      updatedAt: Date.now(),
    }))
  }

  invalidate(): void {
    this.#state.update((state) => ({ ...state, isInvalidated: true }))
  }

  shouldFetch(staleTime: number): boolean {
    const state = this.state()
    return (
      state.status !== 'success' ||
      state.isInvalidated ||
      this.#isStale(staleTime)
    )
  }

  #isStale(staleTime: number): boolean {
    return Date.now() - this.state().updatedAt > staleTime
  }

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null
  }

  destroy(): void {
    this.cancel()
    this.#clearGcTimer()
  }

  #scheduleGc(): void {
    this.#clearGcTimer()

    this.#gcTimer = setTimeout(() => {
      this.#gcTimer = null
      this.#cache.remove(this)
    }, this.#gcTime)
  }

  #clearGcTimer(): void {
    if (this.#gcTimer === null) return

    clearTimeout(this.#gcTimer)
    this.#gcTimer = null
  }
}
