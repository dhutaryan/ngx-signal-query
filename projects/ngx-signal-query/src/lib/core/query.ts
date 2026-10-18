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

import { CancelledError } from './cancelled-error'
import type { QueryCache } from './query-cache'
import { defaultRetryDelay, resolveRetryDelay, shouldRetry } from './retryer'
import { type Deferred, deferred, isValidTimeout, replaceData } from './utils'
import type {
  DefaultedQueryOptions,
  QueryKey,
  QueryOptions,
  QueryState,
  StructuralSharingValue,
} from './types'

/**
 * An observer of a query, as the query sees it: the query asks its observers
 * how to fetch it when it refetches on their behalf (after invalidation, on
 * window focus or reconnect), and how data written into it by hand merges.
 *
 * @internal
 */
export interface QuerySubscriber<TData, TError = Error> {
  /**
   * How this observer would fetch the query right now, and when it wants it
   * refetched, read from its live options; `null` while it doesn't want the
   * query fetched: it is disabled, or its key has already moved on to another
   * query.
   */
  fetchOptions(): Pick<
    DefaultedQueryOptions<TData, TError>,
    | 'queryFn'
    | 'retry'
    | 'retryDelay'
    | 'structuralSharing'
    | 'staleTime'
    | 'refetchOnWindowFocus'
    | 'refetchOnReconnect'
  > | null

  /**
   * How this observer merges data written into the query by hand, read from
   * its live options, whether it's enabled or not.
   */
  structuralSharing(): StructuralSharingValue<TData>
}

/**
 * What a query is created with: its key and the key's hash, the cache it
 * lives in, and how long it stays there once nothing uses it.
 *
 * @internal
 */
export interface QueryConfig {
  key: QueryKey
  queryHash: string
  cache: QueryCache
  gcTime: number
}

/** @internal */
export class Query<TData, TError = Error> {
  readonly key: QueryKey
  readonly queryHash: string

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
  // The promise of the fetch in flight, which every caller that joins the
  // fetch shares, and how to settle it; null while nothing is in flight.
  #outcome: Deferred<TData> | null = null
  // The state the fetch in flight started from, or the last write made
  // during it: stopping the fetch with nothing in its place goes back to it
  // (see #stop). null while nothing is in flight.
  #beforeFetch: QueryState<TData, TError> | null = null
  // The structuralSharing of the fetch whose response the query holds.
  #fetchedStructuralSharing: StructuralSharingValue<TData> | undefined
  readonly #observers = new Set<QuerySubscriber<TData, TError>>()
  #gcTime = 0
  #gcTimer: ReturnType<typeof setTimeout> | null = null
  readonly #cache: QueryCache

  constructor({ key, queryHash, cache, gcTime }: QueryConfig) {
    this.key = key
    this.queryHash = queryHash
    this.#cache = cache
    this.updateGcTime(gcTime)
    // A new query has nothing using it yet: its creator is about to, and if
    // nothing ever does, gc removes it.
    this.#scheduleGc()
  }

  get observerCount(): number {
    return this.#observers.size
  }

  // Keeps the longest gcTime asked for by anything that used the query, as
  // in TanStack: whoever created it, each component that showed it, each
  // fetchQuery. A shorter one doesn't cut short a longer one asked for
  // before. Never below 0.
  updateGcTime(ms: number): void {
    this.#gcTime = Math.max(this.#gcTime, ms)
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

  // Refetches the query if a component shows it: the first observer that
  // wants it fetched decides how, as in TanStack. A fetch in flight is
  // replaced, as it may predate the change the caller is after. Returns the
  // fetch's promise, or undefined if no observer wants the query fetched.
  refetchIfActive(): Promise<TData> | undefined {
    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return this.fetch(options, { cancelRefetch: true })
    }

    return
  }

  // Refetches the query now that the user is back on the page, if one of its
  // observers wants that: its refetchOnWindowFocus is 'always', or true while
  // the data is stale for its staleTime. The first such observer decides
  // how, as in TanStack.
  onFocus(): void {
    this.#refetchOn('refetchOnWindowFocus')
  }

  // The same once the network is back, by refetchOnReconnect.
  onOnline(): void {
    this.#refetchOn('refetchOnReconnect')
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
  //
  // Returns a promise of the data as the query stores it, which every caller
  // that joins the fetch shares. A fetch that replaces this one settles it
  // with its own outcome; one stopped with nothing in its place settles it as
  // cancel() or destroy() says. Nobody has to wait for it.
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
  ): Promise<TData> {
    const running = this.#outcome

    if (running) {
      // Already in-flight: dedupe unless the caller explicitly wants a fresh
      // fetch (e.g. invalidate/refetch) — then replace the old one.
      if (!cancelRefetch) return running.promise

      this.#subscription?.unsubscribe()
    }

    const outcome = deferred<TData>()

    // Its result or error lands in the state either way, so a caller may
    // ignore the promise: handled here, a failure doesn't surface as an
    // unhandled rejection, and whoever awaits the promise still gets it.
    outcome.promise.catch(() => undefined)
    // Whoever waits for the fetch this one replaces gets this one's outcome.
    running?.resolve(outcome.promise)
    this.#outcome = outcome

    // A fetch that replaces one in flight keeps the state the first one
    // started from.
    if (!running) this.#beforeFetch = this.state()

    // A query with no data reads like a first load while it fetches, even
    // after a failure: 'pending' with no error, so a loading state and
    // placeholderData show rather than the old error. One with data keeps
    // its status and error until the response, as in TanStack.
    this.#state.update((state) => ({
      ...state,
      ...(state.data === undefined && { status: 'pending', error: null }),
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
          this.#outcome = null
          this.#beforeFetch = null
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
          outcome.resolve(data)
          this.#scheduleGc()
        },
        error: (err) => {
          this.#outcome = null
          this.#beforeFetch = null
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
          }))
          outcome.reject(err)
          this.#scheduleGc()
        },
      })

    return outcome.promise
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

    // A write made during a fetch is what stopping the fetch goes back to.
    if (this.#inFlight()) this.#beforeFetch = this.state()

    // A write counts as use: a query nobody observes is kept for another
    // gcTime, so a setQueryData write isn't collected before anyone shows it.
    this.#scheduleGc()
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

  // Stops the fetch in flight. Whoever waits for it gets the data the query
  // holds, as in TanStack, or a CancelledError if it holds none.
  cancel(): void {
    const { data } = this.state()
    const fetching = this.#inFlight()

    this.#stop((outcome) =>
      data === undefined
        ? outcome.reject(new CancelledError())
        : outcome.resolve(data),
    )

    // Only a fetch that stops can leave the query unused: cancelling none
    // mustn't put off its gc.
    if (fetching) this.#scheduleGc()
  }

  // The query is thrown away with its data, so whoever waits for its fetch
  // gets a CancelledError, as in TanStack.
  destroy(): void {
    this.#stop((outcome) => outcome.reject(new CancelledError()))
    this.#clearGcTimer()
  }

  // Inclusive: data fetched exactly `staleTime` ago is already stale. This
  // matters for seeded data (initialData is stamped with the current time), so
  // the default staleTime of 0 still means "stale at once" → background
  // refetch, rather than depending on whether a millisecond happened to pass.
  #isStale(staleTime: number): boolean {
    return Date.now() - this.state().updatedAt >= staleTime
  }

  #inFlight(): boolean {
    return this.#outcome !== null
  }

  // Stops the fetch in flight, if any, and settles its promise with settle.
  #stop(settle: (outcome: Deferred<TData>) => void): void {
    const outcome = this.#outcome
    const before = this.#beforeFetch

    this.#subscription?.unsubscribe()
    this.#subscription = null
    this.#outcome = null
    this.#beforeFetch = null

    if (outcome) settle(outcome)

    // The fetch is no longer running, so isFetching mustn't stay stuck true,
    // and what the fetch wrote over goes back to how it was: a query that
    // failed shows its error again, as in TanStack. Data and the stale mark
    // aren't the fetch's to put back: they stay as written meanwhile, so an
    // invalidation made during the fetch still holds.
    if (before) {
      this.#state.update((state) => ({
        ...state,
        status: before.status,
        error: before.error,
        failureCount: before.failureCount,
        failureReason: before.failureReason,
        isFetching: false,
      }))
    }
  }

  // A fetch in flight is kept, as in TanStack, and the observers aren't even
  // asked: fetch() would drop the refetch anyway.
  #refetchOn(option: 'refetchOnWindowFocus' | 'refetchOnReconnect'): void {
    if (this.#inFlight()) return

    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (!options || options[option] === false) continue

      if (options[option] === 'always' || this.shouldFetch(options.staleTime)) {
        this.fetch(options)

        return
      }
    }
  }

  // Removes the query gcTime from now, unless something uses it by then: an
  // observer, or a fetch of it in flight. Called whenever the query may have
  // become unused: when it's created, when its last observer leaves, when a
  // fetch of it ends, when data is written into it by hand.
  #scheduleGc(): void {
    this.#clearGcTimer()

    // While observed, the query is in use: the last observer leaving calls
    // this again. Infinity, or a gcTime no timer can hold, keeps the query
    // until something removes it: a browser would run the timer at once.
    if (this.#observers.size > 0 || !isValidTimeout(this.#gcTime)) return

    this.#gcTimer = setTimeout(() => {
      this.#gcTimer = null

      // A fetch still in flight keeps it: the fetch's end calls this again.
      if (!this.#inFlight()) this.#cache.remove(this)
    }, this.#gcTime)
  }

  #clearGcTimer(): void {
    if (this.#gcTimer === null) return

    clearTimeout(this.#gcTimer)
    this.#gcTimer = null
  }
}
