import { type NgZone, type PendingTasks, signal } from '@angular/core'
import {
  type Observable,
  defer,
  isObservable,
  map,
  take,
  throwIfEmpty,
  Subscription,
} from 'rxjs'

import { CancelledError } from './cancelled-error'
import type { QueryCache } from './query-cache'
import { countFailure, defaultRetryDelay, retryer } from './retryer'
import { type Deferred, deferred, isValidTimeout, replaceData } from './utils'
import { requestOutsideZone } from './zone'
import type {
  DefaultedQueryOptions,
  QueryFunction,
  QueryFunctionContext,
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
export interface QuerySubscriber<TData, TError = Error, TQueryFnData = TData> {
  /**
   * How this observer would fetch the query right now, and when it wants it
   * refetched, read from its live options; `null` while it doesn't want the
   * query fetched: it is disabled, its options throw, or its key has already
   * moved on to another query.
   */
  fetchOptions():
    | (FetchArgs<TData, TError, TQueryFnData> &
        Pick<
          DefaultedQueryOptions<TData, TError>,
          | 'retry'
          | 'retryDelay'
          | 'structuralSharing'
          | 'staleTime'
          | 'refetchOnWindowFocus'
          | 'refetchOnReconnect'
        >)
    | null

  /**
   * How this observer would refetch the query by hand, as its refetch()
   * does, enabled or not; `null` while its options throw, or once its key has
   * moved on to another query.
   */
  refetchOptions(): ReturnType<
    QuerySubscriber<TData, TError, TQueryFnData>['fetchOptions']
  >

  /**
   * Whether this observer's queryFn fetches the query with this hash right
   * now: its live options ask for that key, whether or not its effects have
   * moved it there yet. While its options throw, whether that's the query it
   * shows: nothing says its key moved on, and the request it asked for
   * stands. Never once the observer is destroyed.
   */
  fetches(queryHash: string): boolean

  /**
   * How this observer merges data written into the query by hand, read from
   * its live options, whether it's enabled or not; `undefined` while its
   * options throw.
   */
  structuralSharing(): StructuralSharingValue<TData> | undefined
}

/**
 * What a query is created with: its key and the key's hash, the cache it
 * lives in, how long it stays there once nothing uses it, the app's pending
 * tasks, one of which each of its fetches holds while in flight, and
 * Angular's zone, which its requests and its gc timer stay out of.
 *
 * @internal
 */
export interface QueryConfig {
  key: QueryKey
  queryHash: string
  cache: QueryCache
  gcTime: number
  pendingTasks: Pick<PendingTasks, 'add'>
  zone: Pick<NgZone, 'run' | 'runOutsideAngular'>
}

/**
 * One attempt of a fetch: makes its requests with `request` and gives the
 * data the query stores. `request` calls the attempt's query function with
 * `context` added to the query's key and the fetch's signal, which it can't
 * replace (see Query#request). An attempt that makes all its requests anew,
 * rather than going on from what an earlier attempt or the query's data
 * holds, calls `startOver()` first: what was read before it no longer keeps
 * the query marked stale, nor asks for the refetch queued during a first
 * load.
 *
 * @internal
 */
export type FetchAttempt<TQueryFnData, TData> = (
  request: (context?: Record<string, unknown>) => Observable<TQueryFnData>,
  startOver: () => void,
) => Observable<TData>

/**
 * How a fetch gets the data the query stores from its query function. Called
 * once, as the fetch starts, with the data the query holds then. The attempt
 * it gives is made again for each retry, so what the attempts keep, as the
 * pages fetched so far, carries over from one to the next.
 *
 * @internal
 */
export type FetchBehavior<TQueryFnData, TData> = (
  data: TData | undefined,
) => FetchAttempt<TQueryFnData, TData>

/**
 * What a fetch runs with, as its caller asks for it: the query function and
 * the retry policy, as a query's options give them; how the response merges
 * with the data the query holds; and how the fetch gets that data from the
 * query function.
 *
 * @internal
 */
export type FetchArgs<TData, TError = Error, TQueryFnData = TData> = Pick<
  QueryOptions<TQueryFnData, TError>,
  'queryFn' | 'retry' | 'retryDelay'
> & {
  structuralSharing?: StructuralSharingValue<TData>
  behavior?: FetchBehavior<TQueryFnData, TData>
}

/**
 * What a fetch made with a query's options runs with: its query function,
 * its retry policy and how its data merges, taken field by field, so nothing
 * else an options object holds reaches the fetch.
 *
 * @internal
 */
export function fetchArgsOf<TData, TError>(
  options: DefaultedQueryOptions<TData, TError>,
): Pick<
  DefaultedQueryOptions<TData, TError>,
  'queryFn' | 'retry' | 'retryDelay' | 'structuralSharing'
> {
  return {
    queryFn: options.queryFn,
    retry: options.retry,
    retryDelay: options.retryDelay,
    structuralSharing: options.structuralSharing,
  }
}

// Who asks for a fetch: a component, by the handle it shows the query with,
// or 'caller', a caller no component owns, as fetchQuery().
type Asker<TData, TError, TQueryFnData> =
  | QuerySubscriber<TData, TError, TQueryFnData>
  | 'caller'

// A refetch asked for while a fetch of a query with no data yet runs, to run
// once that fetch ends (see refetch).
interface QueuedRefetch<TData, TError, TQueryFnData> {
  // Settles the promise that everyone who asked for the refetch shares.
  readonly outcome: Deferred<TData>
  // What the last caller that isn't a component, as fetchQuery, asked to
  // fetch with, if one asked.
  callerArgs: FetchArgs<TData, TError, TQueryFnData> | undefined
  // The component that asked last by hand, with its refetch(), if one did.
  byHand: QuerySubscriber<TData, TError, TQueryFnData> | undefined
}

// The fetch in flight, from its first attempt until it lands, fails or is
// stopped. What it needs lives here and goes with it, so nothing carries over
// to the next fetch.
interface InFlightFetch<TData, TError, TQueryFnData> {
  // Settles the promise that every caller joining the fetch shares.
  readonly outcome: Deferred<TData>
  // Its attempts: unsubscribing stops them.
  readonly subscription: Subscription
  // Gives the signal each request of the fetch is made with: one for all its
  // attempts, as in TanStack (see #request). Aborted when the fetch is
  // stopped or replaced, not when it lands or fails.
  readonly abortController: AbortController
  // The state the fetch started from, or the last write made during it:
  // stopping the fetch with nothing in its place goes back to it (see
  // #stop).
  before: QueryState<TData, TError>
  // Whoever asked for the fetch last, and the queryFn it asked with: the
  // caller that started it, one that joined it since, or a caller that asked
  // for a refetch while it runs on a query with no data yet (see refetch). A
  // retry falls back to that queryFn while it still fetches this query (see
  // #retryQueryFn). Replaced whole, so the two always belong together.
  lastAsked: {
    readonly by: Asker<TData, TError, TQueryFnData>
    readonly queryFn: QueryFunction<TQueryFnData>
  }
  // Whether stopping the fetch aborts its request: unsubscribing tears an
  // Observable down (HttpClient aborts the request), and aborting the signal
  // stops a request made with it, as fetch() makes one; any other promise
  // runs to the end anyway. A query function that reads the signal is taken
  // to make its request with it. Each request sets it (see #request), so
  // while the fetch waits to retry, the last one decides.
  abortable: boolean
  // Set once the last observer leaves while the request runs on: the request
  // lands as usual, but a failure isn't tried again. Whoever joins the fetch
  // wants its data, so joining clears it.
  retriesStopped: boolean
  // Set when the query is invalidated while the fetch is in flight, or from
  // the start if the data the fetch goes on from is marked: what was read
  // before the change leaves the query marked stale once the response
  // lands. An attempt that starts over clears it (see FetchAttempt): it
  // reads the data after the change.
  invalidated: boolean
  // The refetch to run once the fetch ends; null while nobody asked for one.
  queuedRefetch: QueuedRefetch<TData, TError, TQueryFnData> | null
  // Set when a refetch is asked for while the fetch is in flight, for the
  // same reason, and cleared the same way: the refetch runs only if it was
  // asked for since the last attempt that started over began.
  refetchAsked: boolean
  // Removes the app's pending task the fetch holds. While it's held, Angular
  // counts the app as busy: a server render and whenStable() wait for the
  // fetch, whatever its queryFn gets the data with. Removed once the outcome
  // is in the state, or when the fetch stops.
  readonly removeTask: () => void
  // The failures the checks of its responses found (see #checked): another
  // attempt would bring the same, so each ends the attempts at once. This
  // fetch's own only: a query function that passes another query's failure
  // on is retried as any failure is.
  readonly checkFailures: WeakSet<object>
}

// TData is what the query stores, TQueryFnData what its query function gives.
// They're the same unless a fetch makes the data out of several responses,
// as the pages of a list.
/** @internal */
export class Query<TData, TError = Error, TQueryFnData = TData> {
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

  // The fetch in flight; null while nothing is.
  #inFlight: InFlightFetch<TData, TError, TQueryFnData> | null = null
  // The structuralSharing of the fetch whose response the query holds.
  #fetchedStructuralSharing: StructuralSharingValue<TData> | undefined
  readonly #observers = new Set<QuerySubscriber<TData, TError, TQueryFnData>>()
  #gcTime = 0
  #gcTimer: ReturnType<typeof setTimeout> | null = null
  readonly #cache: QueryCache
  readonly #pendingTasks: Pick<PendingTasks, 'add'>
  readonly #zone: Pick<NgZone, 'run' | 'runOutsideAngular'>

  constructor({
    key,
    queryHash,
    cache,
    gcTime,
    pendingTasks,
    zone,
  }: QueryConfig) {
    this.key = key
    this.queryHash = queryHash
    this.#cache = cache
    this.#pendingTasks = pendingTasks
    this.#zone = zone
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
  // before. Never below 0. A NaN, such as `Number()` of a missing setting,
  // keeps the query as Infinity does, but only until the next gcTime
  // replaces it, as in TanStack: Math.max with a NaN would keep it for good.
  updateGcTime(ms: number): void {
    this.#gcTime = Math.max(this.#gcTime || 0, ms)
  }

  addObserver(observer: QuerySubscriber<TData, TError, TQueryFnData>): void {
    this.#observers.add(observer)
    this.#clearGcTimer()
  }

  removeObserver(observer: QuerySubscriber<TData, TError, TQueryFnData>): void {
    // An observer this query doesn't have changes nothing: it mustn't cancel
    // the fetch or schedule gc while others still watch.
    if (!this.#observers.delete(observer)) return

    // No observers left: nobody waits for the fetch in flight any more. Stop
    // it if that aborts its request; a request that runs on anyway is let
    // land, so its response isn't thrown away, but nobody is left to want a
    // failure tried again. Then schedule gc to dispose the query if no
    // observer returns.
    if (this.#observers.size === 0) {
      if (this.#inFlight?.abortable) this.cancel()
      else if (this.#inFlight) this.#inFlight.retriesStopped = true
      this.#scheduleGc()
    }
  }

  // Refetches the query if a component shows it: the first observer that
  // wants it fetched decides how, as in TanStack (see refetch). Returns the
  // refetch's promise, or undefined if no observer wants the query fetched.
  refetchIfActive(): Promise<TData> | undefined {
    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return this.refetch(options, observer)
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
  // its first observer with a say decides, enabled or not; with none, the way
  // its data was fetched; undefined if neither has a say. An observer whose
  // options throw has no say.
  structuralSharing(): StructuralSharingValue<TData> | undefined {
    for (const observer of this.#observers) {
      const sharing = observer.structuralSharing()

      if (sharing !== undefined) return sharing
    }

    return this.#fetchedStructuralSharing
  }

  // Without a structuralSharing setting the response is stored as is: the
  // default is the client's to resolve. Without a behavior, the fetch makes
  // one request, whose data the query stores.
  //
  // Returns a promise of the data as the query stores it, which every caller
  // that joins the fetch shares. A fetch that replaces this one settles it
  // with its own outcome; one stopped with nothing in its place settles it as
  // cancel() or destroy() says. Nobody has to wait for it.
  //
  // `by` is who asks: the component the fetch is made for, or, by default, a
  // caller no component owns, as fetchQuery().
  fetch(
    {
      queryFn,
      retry = 0,
      retryDelay = defaultRetryDelay,
      structuralSharing = false,
      behavior,
    }: FetchArgs<TData, TError, TQueryFnData>,
    {
      cancelRefetch = false,
      by = 'caller',
    }: {
      cancelRefetch?: boolean
      by?: Asker<TData, TError, TQueryFnData>
    } = {},
  ): Promise<TData> {
    const running = this.#inFlight

    if (running) {
      // Already in-flight: dedupe unless the caller explicitly wants a fresh
      // fetch (e.g. invalidate/refetch) — then replace the old one. A caller
      // that joins hands its queryFn over for the retries to come, and wants
      // them made, even after the observers the fetch was started for left.
      if (!cancelRefetch) {
        running.lastAsked = { by, queryFn }
        running.retriesStopped = false

        return running.outcome.promise
      }

      running.subscription.unsubscribe()
    }

    const outcome = deferred<TData>()

    // Its result or error lands in the state either way, so a caller may
    // ignore the promise: handled here, a failure doesn't surface as an
    // unhandled rejection, and whoever awaits the promise still gets it.
    outcome.promise.catch(() => undefined)
    // Whoever waits for the fetch this one replaces gets this one's outcome,
    // and so does whoever waits for a refetch queued after it: this fetch
    // starts after they asked.
    running?.outcome.resolve(outcome.promise)
    running?.queuedRefetch?.outcome.resolve(outcome.promise)

    const inFlight: InFlightFetch<TData, TError, TQueryFnData> = {
      outcome,
      subscription: new Subscription(),
      abortController: new AbortController(),
      // A fetch that replaces one in flight keeps the state the first one
      // started from.
      before: running?.before ?? this.state(),
      lastAsked: { by, queryFn },
      abortable: false,
      retriesStopped: false,
      // The data the query holds keeps its mark while a fetch that goes on
      // from it, rather than starting over, lands.
      invalidated: this.state().isInvalidated,
      queuedRefetch: null,
      refetchAsked: false,
      removeTask: this.#pendingTasks.add(),
      checkFailures: new WeakSet(),
    }

    this.#inFlight = inFlight
    // Only now that this fetch holds its task: the app mustn't count as
    // stable in between.
    running?.removeTask()

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

    // Started as the fetch is subscribed to, inside it: a behavior that
    // throws as it starts fails the fetch at once, with no retry, and the
    // call itself doesn't throw.
    const attempts = defer(() => {
      // How each attempt gets the data from its requests, as the behavior
      // says, from the data the query holds as the fetch starts. Without
      // one, each attempt starts over and makes one request, and the query
      // stores what it gives: the query function gives the query's own data
      // then (TQueryFnData is TData), though the types can't tell.
      const attemptWith: FetchAttempt<TQueryFnData, TData> =
        behavior?.(this.state().data) ??
        ((request, startOver) => {
          startOver()

          return request() as unknown as Observable<TData>
        })

      // An attempt that starts over reads the data after any invalidation
      // or refetch asked for so far.
      const startOver = (): void => {
        inFlight.invalidated = false
        inFlight.refetchAsked = false
      }

      // The first attempt runs the caller's queryFn, each retry the one
      // #retryQueryFn picks: it has one, as stopped() below has just found
      // when the wait for the retry ended. Each attempt makes fresh
      // requests, as many as the behavior asks for (a Promise is one-shot),
      // and only the requests leave Angular's zone: see #request. Whatever
      // the behavior makes of its requests, an attempt gives one value, and
      // not undefined, as each request does (see #checked).
      return retryer<TData, TError>({
        attempt: (attemptIndex) => {
          const attemptQueryFn =
            attemptIndex === 0 ? queryFn : this.#retryQueryFn(inFlight)!

          return this.#checked(
            attemptWith(
              (context) => this.#request(attemptQueryFn, inFlight, context),
              startOver,
            ),
            inFlight,
          )
        },
        retry,
        retryDelay,
        onFail: (failureCount, failureReason) =>
          this.#state.update((state) => ({
            ...state,
            failureCount,
            failureReason,
          })),
        // The retries stop once the last observer has left (retriesStopped,
        // as in TanStack) or once no queryFn fetches this query any more (see
        // #retryQueryFn). From then on, a failure ends the fetch at once, and
        // so does the end of a wait for a retry. Whoever joins the fetch
        // meanwhile hands its queryFn over and clears retriesStopped, so the
        // retry goes out on time.
        stopped: () =>
          inFlight.retriesStopped || this.#retryQueryFn(inFlight) === null,
        final: (error) =>
          error instanceof Object && inFlight.checkFailures.has(error),
      })
    }).pipe(
      // Keeps what didn't change from the data the query holds when the
      // response lands, a write made during the fetch included. After the
      // retries: a structuralSharing function that throws fails the fetch
      // rather than retrying it, or leaving it in flight.
      map((data) => replaceData(this.state().data, data, structuralSharing)),
    )

    inFlight.subscription.add(
      attempts.subscribe({
        next: (data) => {
          this.#inFlight = null
          this.#fetchedStructuralSharing = structuralSharing
          this.#state.set({
            data,
            status: 'success',
            error: null,
            isFetching: false,
            // Still stale if invalidated after some of this data was read:
            // it may predate the change.
            isInvalidated: inFlight.invalidated,
            failureCount: 0,
            failureReason: null,
            updatedAt: Date.now(),
          })
          outcome.resolve(data)
          this.#refetchIfAsked(inFlight)
          this.#scheduleGc()
          // Last: whatever waits for the app to settle finds the data in, or
          // the refetch queued after it holding a task of its own.
          inFlight.removeTask()
        },
        error: (err) => {
          this.#inFlight = null
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
            ...countFailure(state, err),
          }))
          outcome.reject(err)
          this.#refetchIfAsked(inFlight)
          this.#scheduleGc()
          inFlight.removeTask()
        },
      }),
    )
    // Stopping the fetch or replacing it unsubscribes it, and only that does:
    // its signal is aborted then. After its attempts are let go of, so a
    // request that fails as the signal aborts it doesn't fail the fetch:
    // whoever waits for it gets what stopping or replacing it settles it with.
    inFlight.subscription.add(() => inFlight.abortController.abort())

    return outcome.promise
  }

  // Refetches the query for `by`, whose args they are: the first component
  // that wants the query fetched, as an invalidation asks; a component
  // itself, by its refetch() (byHand); or 'caller', as fetchQuery() with
  // cancelRefetch asks. The fetch in flight may predate the reason: with
  // data, it is replaced; with none yet, it is let land and show, and the
  // query is fetched once more after it (see #refetchIfAsked), however many
  // refetches are asked for meanwhile. Whoever asks gets that refetch's
  // promise. A caller hands its queryFn over for the retries to come, as a
  // caller that joins does.
  refetch(
    args: FetchArgs<TData, TError, TQueryFnData>,
    by: Asker<TData, TError, TQueryFnData>,
    { byHand = false }: { byHand?: boolean } = {},
  ): Promise<TData> {
    const running = this.#inFlight

    if (!running || this.state().data !== undefined) {
      return this.fetch(args, { cancelRefetch: true, by })
    }

    running.refetchAsked = true

    if (!running.queuedRefetch) {
      const outcome = deferred<TData>()

      // Handled here, as a fetch's own promise is: the refetch's failure
      // shows in the state, and a caller may ignore the promise.
      outcome.promise.catch(() => undefined)
      running.queuedRefetch = {
        outcome,
        callerArgs: undefined,
        byHand: undefined,
      }
    }

    if (by === 'caller') {
      running.queuedRefetch.callerArgs = args
      running.lastAsked = { by, queryFn: args.queryFn }
    } else if (byHand) {
      running.queuedRefetch.byHand = by
    }

    return running.queuedRefetch.outcome.promise
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
    // It leaves the fetch's `invalidated` as it is: the response replaces
    // the write when it lands, and may have been read before the change.
    if (this.#inFlight) this.#inFlight.before = this.state()

    // A write counts as use: a query nobody observes is kept for another
    // gcTime, so a setQueryData write isn't collected before anyone shows it.
    this.#scheduleGc()
  }

  invalidate(): void {
    this.#state.update((state) => ({ ...state, isInvalidated: true }))

    // The fetch in flight may have read the data before the change, so its
    // response mustn't clear the mark. Hence no early return when the query
    // is marked already: the fetch may be one that the earlier mark started.
    if (this.#inFlight) this.#inFlight.invalidated = true
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
    const fetching = this.#inFlight !== null

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

  // Stops the fetch in flight, if any, and settles its promise with settle.
  // A refetch queued after it is dropped: whoever asked for it gets the same.
  #stop(settle: (outcome: Deferred<TData>) => void): void {
    const inFlight = this.#inFlight

    if (!inFlight) return

    inFlight.subscription.unsubscribe()
    this.#inFlight = null
    settle(inFlight.outcome)
    inFlight.queuedRefetch?.outcome.resolve(inFlight.outcome.promise)

    const { before } = inFlight

    // The fetch is no longer running, so isFetching mustn't stay stuck true,
    // and what the fetch wrote over goes back to how it was: a query that
    // failed shows its error again, as in TanStack. Data and the stale mark
    // aren't the fetch's to put back: they stay as written meanwhile, so an
    // invalidation made during the fetch still holds.
    this.#state.update((state) => ({
      ...state,
      status: before.status,
      error: before.error,
      failureCount: before.failureCount,
      failureReason: before.failureReason,
      isFetching: false,
    }))
    inFlight.removeTask()
  }

  // Runs the refetch queued after the fetch that just ended (see
  // #queuedRefetchArgs), unless an attempt that started over began after the
  // refetch was last asked for: then all the data the fetch lands with was
  // read after the reason for the refetch (see InFlightFetch.refetchAsked).
  // Whoever asked gets the refetch's outcome, or the fetch's.
  #refetchIfAsked(inFlight: InFlightFetch<TData, TError, TQueryFnData>): void {
    const queued = inFlight.queuedRefetch

    if (!queued) return

    const asked = inFlight.refetchAsked ? this.#queuedRefetchArgs(queued) : null

    queued.outcome.resolve(
      asked
        ? this.fetch(asked.args, { by: asked.by })
        : inFlight.outcome.promise,
    )
  }

  // What the queued refetch runs with, and who it's made for: the args of
  // the caller that asked, if one did; else as the component that asked by
  // hand would refetch it, as its refetch() does with data, while it still
  // shows the query, enabled or not; else as the first component that wants
  // the query fetched would fetch it, as an invalidation refetches. With none
  // of them, the refetch is dropped: an invalidation leaves a query that only
  // disabled components show alone.
  #queuedRefetchArgs({
    callerArgs,
    byHand,
  }: QueuedRefetch<TData, TError, TQueryFnData>): {
    args: FetchArgs<TData, TError, TQueryFnData>
    by: Asker<TData, TError, TQueryFnData>
  } | null {
    if (callerArgs) return { args: callerArgs, by: 'caller' }

    if (byHand && this.#observers.has(byHand)) {
      const own = byHand.refetchOptions()

      if (own) return { args: own, by: byHand }
    }

    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return { args: options, by: observer }
    }

    return null
  }

  // A fetch in flight is kept, as in TanStack, and the observers aren't even
  // asked: fetch() would drop the refetch anyway.
  #refetchOn(option: 'refetchOnWindowFocus' | 'refetchOnReconnect'): void {
    if (this.#inFlight) return

    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (!options || options[option] === false) continue

      if (options[option] === 'always' || this.shouldFetch(options.staleTime)) {
        this.fetch(options, { by: observer })

        return
      }
    }
  }

  // The queryFn a retry runs: that of the first observer that wants the
  // query fetched, as for a refetch, else that of whoever asked for the
  // fetch last, while it still fetches this query: always for a caller no
  // component owns, as fetchQuery(); for an observer, while its queryFn
  // does, enabled or not (see QuerySubscriber.fetches). Not simply the one
  // the fetch started with: a queryFn may read its key's value only when it
  // runs, as `() => api(this.id())` does, and by the retry its component may
  // have moved on to another key, its effects caught up or not. An observer
  // whose key moved on doesn't want this query fetched. Null when no queryFn
  // fetches it any more: the retries stop then, as when the last observer
  // leaves (see fetch).
  #retryQueryFn(
    inFlight: InFlightFetch<TData, TError, TQueryFnData>,
  ): QueryFunction<TQueryFnData> | null {
    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return options.queryFn
    }

    const { by, queryFn } = inFlight.lastAsked

    return by === 'caller' || by.fetches(this.queryHash) ? queryFn : null
  }

  // One request of a fetch: made outside Angular's zone, with its outcome
  // brought back to where the fetch was asked for from (see
  // requestOutsideZone): with zone.js, what the request waits on mustn't
  // keep the app from counting as stable. The task the fetch holds keeps the
  // app busy until the outcome is in all the same. It hands the query
  // function the query's key and the fetch's signal, on top of what the
  // behavior adds for this request (`extra`), takes the first value an
  // Observable gives and lets go of it, and sets whether stopping the fetch
  // aborts it: it does for an Observable, and for a request whose query
  // function reads the signal.
  #request(
    queryFn: QueryFunction<TQueryFnData>,
    inFlight: InFlightFetch<TData, TError, TQueryFnData>,
    extra?: Record<string, unknown>,
  ): Observable<TQueryFnData> {
    const response = requestOutsideZone(this.#zone, () => {
      const context: QueryFunctionContext = {
        ...extra,
        queryKey: this.key,
        // Read during the call or after it, an await later say.
        get signal() {
          inFlight.abortable = true

          return inFlight.abortController.signal
        },
      }

      inFlight.abortable = false

      const request = queryFn(context)

      if (isObservable(request)) inFlight.abortable = true

      return request
    })

    return this.#checked(response, inFlight)
  }

  // A response gives one value, and not undefined, or it fails the fetch: it
  // went through, and another one would bring the same, so the failure
  // counts but isn't tried again (see InFlightFetch.checkFailures). undefined
  // is what a query holds while it has no data: null says "nothing here".
  // Checked before the merge, so a structuralSharing function only ever gets
  // data.
  #checked<T>(
    response: Observable<T>,
    inFlight: InFlightFetch<TData, TError, TQueryFnData>,
  ): Observable<T> {
    const failure = (reason: string): Error => {
      const error = new Error(`Query function for ${this.queryHash} ${reason}`)

      inFlight.checkFailures.add(error)

      return error
    }

    return response.pipe(
      take(1),
      throwIfEmpty(() => failure('completed without emitting a value')),
      map((data) => {
        if (data === undefined) {
          throw failure('produced undefined; return null for no data')
        }

        return data
      }),
    )
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

    // Outside Angular's zone: with zone.js, a timer pending there keeps the
    // app from counting as stable, this one for gcTime. Nothing on screen
    // shows a query nobody uses, so its removal needs no change detection.
    this.#gcTimer = this.#zone.runOutsideAngular(() =>
      setTimeout(() => {
        this.#gcTimer = null

        // A fetch still in flight keeps it: the fetch's end calls this again.
        if (!this.#inFlight) this.#cache.remove(this)
      }, this.#gcTime),
    )
  }

  #clearGcTimer(): void {
    if (this.#gcTimer === null) return

    clearTimeout(this.#gcTimer)
    this.#gcTimer = null
  }
}
