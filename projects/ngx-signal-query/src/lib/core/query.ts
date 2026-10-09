import { signal } from '@angular/core'
import {
  defer,
  from,
  map,
  retry as retryOperator,
  take,
  throwIfEmpty,
  timer,
  type Subscription,
} from 'rxjs'

import type { QueryCache } from './query-cache'
import { defaultRetryDelay, resolveRetryDelay, shouldRetry } from './retryer'
import { replaceData } from './utils'
import type {
  DefaultedQueryOptions,
  QueryKey,
  QueryOptions,
  QueryState,
  StructuralSharingValue,
} from './types'

const DEFAULT_GC_TIME = 5 * 60 * 1000

/**
 * An observer of a query, as the query sees it: the query asks its observers
 * how to fetch it when it refetches on their behalf (after invalidation), and
 * how data written into it by hand merges.
 *
 * @internal
 */
export interface QuerySubscriber<TData, TError = Error> {
  /**
   * How this observer would fetch the query right now, read from its live
   * options; `null` while it doesn't want the query fetched: it is disabled,
   * or its key has already moved on to another query.
   */
  fetchOptions(): Pick<
    DefaultedQueryOptions<TData, TError>,
    'queryFn' | 'retry' | 'retryDelay' | 'structuralSharing'
  > | null

  /**
   * How this observer merges data written into the query by hand, read from
   * its live options, whether it's enabled or not.
   */
  structuralSharing(): StructuralSharingValue<TData>
}

/** @internal */
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

  // `state` must follow `#state`: a public field can't precede the private
  // field it reads during initialization (field init order).
  // eslint-disable-next-line @typescript-eslint/member-ordering
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null
  // The structuralSharing of the fetch whose response the query holds.
  #fetchedStructuralSharing: StructuralSharingValue<TData> | undefined
  readonly #observers = new Set<QuerySubscriber<TData, TError>>()
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
    return this.#observers.size
  }

  setGcTime(ms: number): void {
    this.#gcTime = ms
  }

  addObserver(observer: QuerySubscriber<TData, TError>): void {
    this.#observers.add(observer)
    this.#clearGcTimer()
  }

  removeObserver(observer: QuerySubscriber<TData, TError>): void {
    // An observer this query doesn't have changes nothing: it mustn't cancel
    // the fetch or schedule gc while others still watch.
    if (!this.#observers.delete(observer)) return

    // No observers left: cancel any in-flight fetch (nobody is waiting for it)
    // and schedule gc to dispose the query if no observer returns.
    if (this.#observers.size === 0) {
      this.cancel()
      this.#scheduleGc()
    }
  }

  // How to refetch this query on its observers' behalf: the first observer
  // that wants it fetched decides, as in TanStack; null if none does.
  activeFetchOptions(): ReturnType<
    QuerySubscriber<TData, TError>['fetchOptions']
  > {
    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return options
    }

    return null
  }

  // How data written into the query by hand merges with what it holds: as
  // its first observer says, enabled or not; with none, the way its data was
  // fetched; undefined if neither has a say.
  structuralSharing(): StructuralSharingValue<TData> | undefined {
    const [observer] = this.#observers

    return observer
      ? observer.structuralSharing()
      : this.#fetchedStructuralSharing
  }

  // Without a structuralSharing setting the response is stored as is: the
  // default is the client's to resolve.
  fetch(
    {
      queryFn,
      retry = 0,
      retryDelay = defaultRetryDelay,
      structuralSharing = false,
    }: Pick<
      QueryOptions<TData, TError>,
      'queryFn' | 'retry' | 'retryDelay' | 'structuralSharing'
    >,
    { cancelRefetch = false }: { cancelRefetch?: boolean } = {},
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
        // Keeps what didn't change from the data the query holds when the
        // response lands, a write made during the fetch included. After the
        // retries: a structuralSharing function that throws fails the fetch
        // rather than retrying it, or leaving it in flight.
        map((data) => replaceData(this.state().data, data, structuralSharing)),
      )
      .subscribe({
        next: (data) => {
          this.#fetchedStructuralSharing = structuralSharing
          this.#state.set({
            data,
            status: 'success',
            error: null,
            isFetching: false,
            isInvalidated: false,
            failureCount: 0,
            failureReason: null,
            updatedAt: Date.now(),
          })
        },
        error: (err) =>
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
          })),
      })
  }

  // Without a structuralSharing setting the data is stored as is: which one
  // a write uses is the client's to resolve.
  setData(
    data: TData,
    {
      updatedAt = Date.now(),
      structuralSharing = false,
    }: {
      updatedAt?: number
      structuralSharing?: StructuralSharingValue<TData>
    } = {},
  ): void {
    this.#state.update((state) => ({
      ...state,
      data: replaceData(state.data, data, structuralSharing),
      status: 'success',
      error: null,
      isInvalidated: false,
      failureCount: 0,
      failureReason: null,
      updatedAt,
    }))

    // Keep an orphaned query (no observers) alive for another gcTime so a
    // setQueryData write isn't collected before anyone subscribes.
    if (this.#observers.size === 0) this.#scheduleGc()
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

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null

    // The fetch is no longer running; clear the in-flight flag so isFetching
    // doesn't stay stuck true after a cancellation.
    if (this.state().isFetching) {
      this.#state.update((state) => ({ ...state, isFetching: false }))
    }
  }

  destroy(): void {
    this.cancel()
    this.#clearGcTimer()
  }

  // Inclusive: data fetched exactly `staleTime` ago is already stale. This
  // matters for seeded data (initialData is stamped with the current time), so
  // the default staleTime of 0 still means "stale at once" → background
  // refetch, rather than depending on whether a millisecond happened to pass.
  #isStale(staleTime: number): boolean {
    return Date.now() - this.state().updatedAt >= staleTime
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
