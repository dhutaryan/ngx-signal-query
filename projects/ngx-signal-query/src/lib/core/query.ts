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
import type { QueryCacheCallbacks } from './query-cache-callbacks'
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
 * The handle a QueryObserver registers with a query (Query#addObserver):
 * the query keeps these as its observers. It asks them how to fetch it
 * whenever it fetches on their behalf (see fetchOptions), and how data
 * written into it by hand merges.
 *
 * @internal
 */
export interface QuerySubscriber<TData, TError = Error, TQueryFnData = TData> {
  /**
   * How this observer would fetch the query right now, and when it wants it
   * refetched, read from its live options; `null` while it doesn't want the
   * query fetched: it is disabled, its options throw, its key has already
   * moved on to another query, or it is unlisted (see createQueryObserver),
   * like an injectQueries query whose key has left the list.
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
   * How this observer would refetch the query by hand, like its refetch()
   * does, enabled or not; `null` while its options throw, once its key has
   * moved on to another query, or while it is unlisted.
   */
  refetchOptions(): ReturnType<
    QuerySubscriber<TData, TError, TQueryFnData>['fetchOptions']
  >

  /**
   * Whether this observer's queryFn asks for the query with this hash right
   * now: its live options ask for that key, whether or not its effects have
   * moved it there yet, and whether or not it is destroyed, since a queryFn
   * still reads what it read before its observer went away.
   * - While its options throw: whether that's the query it shows, since
   *   nothing says its key moved on, and the request it asked for stands.
   * - While it is unlisted: never, since a queryFn that reads a signal when
   *   it runs may ask for another key by then.
   */
  asksFor(queryHash: string): boolean

  /**
   * Whether this observer's queryFn fetches the query with this hash on the
   * observer's behalf: it asks for that query (see asksFor), and the observer
   * isn't destroyed.
   */
  fetches(queryHash: string): boolean

  /**
   * How this observer merges data written into the query by hand, read from
   * its live options, whether it's enabled or not; `undefined` while its
   * options throw, or while it is unlisted.
   */
  structuralSharing(): StructuralSharingValue<TData> | undefined
}

/**
 * What a query is created with.
 *
 * @internal
 */
export interface QueryConfig {
  key: QueryKey
  queryHash: string
  /**
   * The cache it lives in, which it only reaches to remove itself from once
   * unused.
   */
  cache: Pick<QueryCache, 'remove'>
  /** How long it stays in the cache once nothing uses it. */
  gcTime: number
  /** The app's pending tasks: each of its fetches holds one while in flight. */
  pendingTasks: Pick<PendingTasks, 'add'>
  /** Angular's zone, which its requests and its gc timer stay out of. */
  zone: Pick<NgZone, 'run' | 'runOutsideAngular'>
  /**
   * The app's callbacks, which hear of each of its fetches that lands or
   * fails.
   */
  callbacks: QueryCacheCallbacks
}

/**
 * One attempt of a fetch: makes its requests with `request` and gives the
 * data the query stores. `request` calls a query function with `context`
 * added to the query's key and the fetch's signal, which it can't replace
 * (see Query#request).
 *
 * - `request` gives null instead of a request once no query function asks
 *   for the query's key any more (see Query#nextQueryFn), but never for an
 *   attempt's first request. On null, the attempt ends with the data it
 *   has, such as the pages fetched so far.
 * - An attempt that makes all its requests anew, rather than going on from
 *   what an earlier attempt or the query's data holds, calls `startOver()`
 *   first: an invalidation made before then no longer leaves the data it
 *   lands with marked stale, and a refetch asked for before then during a
 *   first load no longer runs (see InFlightFetch.invalidated and
 *   refetchAsked).
 *
 * @internal
 */
export type FetchAttempt<TQueryFnData, TData> = (attempt: {
  request: (
    context?: Record<string, unknown>,
  ) => Observable<TQueryFnData> | null
  startOver: () => void
}) => Observable<TData>

/**
 * Which way a fetch adds a page to the pages a query holds: 'forward' adds
 * the next one, 'backward' the one before the first.
 *
 * @internal
 */
export type FetchDirection = 'forward' | 'backward'

/**
 * A query's state as the query keeps it: the {@link QueryState} its
 * observers show, and which way its fetch adds a page.
 *
 * @internal
 */
export interface InternalQueryState<TData, TError = Error> extends QueryState<
  TData,
  TError
> {
  // Set as a fetch starts: its direction, or null for a fetch that adds no
  // page. Kept once the fetch lands or fails, so a failure tells which fetch
  // it came from, such as the one for the next page. Put back, along with the
  // status and the error, when a fetch is stopped with nothing in its place.
  fetchDirection: FetchDirection | null
  // How many times something has landed in the query: a fetch, with data or
  // with an error, or a write that puts data in it by hand, such as
  // setQueryData or data that a server render fetched. A fetch counts once,
  // with its outcome, not once for each failed attempt; initialData doesn't
  // count. A stopped fetch leaves it as it is. Observers tell from it whether
  // the query was fetched at all, and whether since they started showing it.
  fetchedCount: number
}

/**
 * How a fetch gets the data the query stores from its query function. Called
 * once, as the fetch starts, with the data the query holds then and the
 * fetch's direction, if it adds a page. The attempt it gives is made again
 * for each retry, so what the attempts keep, such as the pages fetched so
 * far, carries over from one to the next.
 *
 * @internal
 */
export type FetchBehavior<TQueryFnData, TData> = (start: {
  data: TData | undefined
  direction?: FetchDirection
}) => FetchAttempt<TQueryFnData, TData>

/**
 * What a fetch runs with, as its caller asks for it: the query function, the
 * retry policy and the meta that the app's callbacks get, as a query's
 * options give them; how the response merges with the data the query holds;
 * how the fetch gets that data from the query function; and, for a fetch that
 * adds a page, which way.
 *
 * @internal
 */
export type FetchArgs<TData, TError = Error, TQueryFnData = TData> = Pick<
  QueryOptions<TQueryFnData, TError>,
  'queryFn' | 'retry' | 'retryDelay' | 'meta'
> & {
  structuralSharing?: StructuralSharingValue<TData>
  behavior?: FetchBehavior<TQueryFnData, TData>
  direction?: FetchDirection
}

/**
 * What a fetch made with a query's options runs with: its query function,
 * its retry policy, how its data merges and its meta, taken field by field,
 * so nothing else an options object holds reaches the fetch.
 *
 * @internal
 */
export function fetchArgsOf<TData, TError, TQueryFnData = TData>(
  options: DefaultedQueryOptions<TData, TError, TQueryFnData>,
): Pick<
  DefaultedQueryOptions<TData, TError, TQueryFnData>,
  'queryFn' | 'retry' | 'retryDelay' | 'structuralSharing' | 'meta'
> {
  return {
    queryFn: options.queryFn,
    retry: options.retry,
    retryDelay: options.retryDelay,
    structuralSharing: options.structuralSharing,
    meta: options.meta,
  }
}

/**
 * Seeds a query that has no data yet with the initialData its options give,
 * so it shows as 'success' at once: a new query ('pending'), or one whose
 * fetch failed before it had any data ('error'). Without an
 * initialDataUpdatedAt, the seed counts as fetched right now, so staleTime
 * applies to it like it does to any other data: a staleTime of 0 still means
 * "stale at once". A function that gives undefined has nothing to seed, and
 * the query loads like it would without one; the function is asked again on
 * each call while the query has no data, and seeds it once it gives data.
 * Nothing fetched the seed, so it doesn't count in
 * InternalQueryState.fetchedCount.
 *
 * @internal
 */
export function applyInitialData<TData, TError, TQueryFnData>(
  query: Query<TData, TError, TQueryFnData>,
  {
    initialData,
    initialDataUpdatedAt,
  }: Pick<QueryOptions<TData, TError>, 'initialData' | 'initialDataUpdatedAt'>,
): void {
  if (initialData === undefined || query.state().data !== undefined) return

  const data =
    typeof initialData === 'function'
      ? (initialData as () => TData | undefined)()
      : initialData

  if (data === undefined) return

  const updatedAt =
    typeof initialDataUpdatedAt === 'function'
      ? initialDataUpdatedAt()
      : (initialDataUpdatedAt ?? Date.now())

  query.setData(data, { updatedAt, seed: true })
}

// Who asks for a fetch: a component, by the handle it shows the query with,
// or 'client', a QueryClient call such as query(), infiniteQuery() or
// fetchQuery(), whose queryFn fetches this key for good.
type Asker<TData, TError, TQueryFnData> =
  | QuerySubscriber<TData, TError, TQueryFnData>
  | 'client'

// A refetch asked for while a fetch of a query with no data yet runs, to run
// once that fetch ends (see refetch).
interface QueuedRefetch<TData, TError, TQueryFnData> {
  // Settles the promise that everyone who asked for the refetch shares.
  readonly outcome: Deferred<TData>
  // What the last QueryClient call, such as query(), asked to fetch with, if
  // one asked.
  clientArgs: FetchArgs<TData, TError, TQueryFnData> | undefined
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
  before: InternalQueryState<TData, TError>
  // Who asked for the fetch last, and the queryFn it asked with: whoever
  // started it, then each asker that joins it, and a 'client' that asks for
  // a refetch while it runs on a query with no data yet (see refetch). A
  // component that joins doesn't replace a 'client', whose queryFn fetches
  // this key for good, while the component may move on to another key; its
  // own queryFn comes first anyway while it shows the query and wants it
  // fetched. #nextQueryFn falls back to it for each request after the
  // fetch's first. Replaced whole, so the two always belong together.
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

/**
 * One cached query: its state, the fetch in flight and the observers that
 * show it. TData is what the query stores, TQueryFnData what its query
 * function gives. They're the same, except for an infinite query, whose
 * data is its pages.
 *
 * @internal
 */
export class Query<TData, TError = Error, TQueryFnData = TData> {
  readonly key: QueryKey
  readonly queryHash: string

  readonly #state = signal<InternalQueryState<TData, TError>>({
    data: undefined,
    status: 'pending',
    error: null,
    isFetching: false,
    isInvalidated: false,
    failureCount: 0,
    failureReason: null,
    updatedAt: 0,
    fetchDirection: null,
    fetchedCount: 0,
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
  // Set by destroy(): the query is thrown away. Code still busy with it may
  // call it after that, such as the end of its fetch, or a loop over the
  // cache's queries, once a callback of the app removed it: it starts no
  // refetch then, and no gc timer.
  #destroyed = false
  readonly #cache: Pick<QueryCache, 'remove'>
  readonly #pendingTasks: Pick<PendingTasks, 'add'>
  readonly #zone: Pick<NgZone, 'run' | 'runOutsideAngular'>
  readonly #callbacks: QueryCacheCallbacks

  constructor({
    key,
    queryHash,
    cache,
    gcTime,
    pendingTasks,
    zone,
    callbacks,
  }: QueryConfig) {
    this.key = key
    this.queryHash = queryHash
    this.#cache = cache
    this.#pendingTasks = pendingTasks
    this.#zone = zone
    this.#callbacks = callbacks
    this.updateGcTime(gcTime)
    // A new query has nothing using it yet: its creator is about to, and if
    // nothing ever does, gc removes it.
    this.#scheduleGc()
  }

  get observerCount(): number {
    return this.#observers.size
  }

  // Keeps the longest gcTime asked for by anything that used the query:
  // whoever created it, each component that showed it, each query(),
  // infiniteQuery() or fetchQuery() call. A shorter one doesn't cut short a
  // longer one asked for before. A longer one starts a running gc countdown
  // over with it: a call that finds fresh data fetches and writes nothing,
  // so nothing else would. Never below 0. A NaN, such as `Number()` of a
  // missing setting, keeps the query as Infinity does, but only until the
  // next gcTime replaces it, as in TanStack: Math.max with a NaN would keep
  // it for good.
  updateGcTime(ms: number): void {
    const previous = this.#gcTime

    this.#gcTime = Math.max(previous || 0, ms)

    if (!Object.is(previous, this.#gcTime)) this.#scheduleGc()
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
  // refetch's promise, or undefined if no observer wants the query fetched
  // or the query is destroyed.
  refetchIfActive(): Promise<TData> | undefined {
    if (this.#destroyed) return

    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return this.refetch(options, { by: observer })
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
  // options throw has no say, and neither has an unlisted one (see
  // QuerySubscriber.structuralSharing).
  structuralSharing(): StructuralSharingValue<TData> | undefined {
    for (const observer of this.#observers) {
      const sharing = observer.structuralSharing()

      if (sharing !== undefined) return sharing
    }

    return this.#fetchedStructuralSharing
  }

  // Without a structuralSharing setting the response is stored as is: the
  // default is the client's to resolve. Without a behavior, the fetch makes
  // one request, whose data the query stores. Once the fetch lands or fails,
  // the app's callbacks get the query with the `meta` of this call (see
  // QueryCacheCallbacks): a caller that joins the fetch doesn't change it.
  //
  // Returns a promise of the data as the query stores it, which every caller
  // that joins the fetch shares. A fetch that replaces this one settles it
  // with its own outcome; one stopped with nothing in its place settles it as
  // cancel() or destroy() says. Nobody has to wait for it.
  //
  // `by` is who asks: the component the fetch is made for, or, by default,
  // 'client', a QueryClient call such as query().
  fetch(
    {
      queryFn,
      retry = 0,
      retryDelay = defaultRetryDelay,
      structuralSharing = false,
      behavior,
      direction,
      meta,
    }: FetchArgs<TData, TError, TQueryFnData>,
    {
      cancelRefetch = false,
      by = 'client',
    }: {
      cancelRefetch?: boolean
      by?: Asker<TData, TError, TQueryFnData>
    } = {},
  ): Promise<TData> {
    const running = this.#inFlight

    if (running) {
      // Already in flight: dedupe unless the caller explicitly wants a fresh
      // fetch (e.g. invalidate/refetch), then replace the old one. Whoever
      // joins wants the requests made, even after the observers the fetch
      // was started for left, and hands its queryFn over for them, unless
      // it's a component and a 'client' asked before it (see
      // InFlightFetch.lastAsked).
      if (!cancelRefetch) {
        if (by === 'client' || running.lastAsked.by !== 'client') {
          running.lastAsked = { by, queryFn }
        }

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
      fetchDirection: direction ?? null,
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
        behavior?.({ data: this.state().data, direction }) ??
        (({ request, startOver }) => {
          startOver()

          // Never null: it's the attempt's first request (see FetchAttempt).
          return request() as unknown as Observable<TData>
        })

      // An attempt that starts over reads the data after any invalidation
      // or refetch asked for so far.
      const startOver = (): void => {
        inFlight.invalidated = false
        inFlight.refetchAsked = false
      }

      // The fetch's first request runs the caller's queryFn; each one after
      // it, a retry's first included, the one #nextQueryFn gives, or none:
      // the behavior then ends the attempt with what it has. A retry finds
      // one: stopped() below has just checked that when the wait ended.
      // Each attempt makes fresh requests, as many as the behavior asks for
      // (a Promise is one-shot), and only the requests leave Angular's zone:
      // see #request. Whatever the behavior makes of its requests, an attempt
      // gives one value, and not undefined, as each request does (see
      // #checked).
      let requested = false
      const request = (
        context?: Record<string, unknown>,
      ): Observable<TQueryFnData> | null => {
        const requestQueryFn = requested
          ? (this.#nextQueryFn(inFlight)?.queryFn ?? null)
          : queryFn

        requested = true

        return (
          requestQueryFn && this.#request(requestQueryFn, inFlight, context)
        )
      }

      return retryer<TData, TError>({
        attempt: () =>
          this.#checked(attemptWith({ request, startOver }), inFlight),
        retry,
        retryDelay,
        onFail: (failureCount, failureReason) =>
          this.#state.update((state) => ({
            ...state,
            failureCount,
            failureReason,
          })),
        // The retries stop once the last observer has left (retriesStopped,
        // as in TanStack), or once nobody who wants them is left: no queryFn
        // asks for this query, or only that of a component that went away
        // (see #nextQueryFn). From then on, a failure ends the fetch at once,
        // and so does the end of a wait for a retry. Whoever joins the fetch
        // meanwhile hands its queryFn over and clears retriesStopped, so the
        // retry goes out on time.
        stopped: () =>
          inFlight.retriesStopped || !this.#nextQueryFn(inFlight)?.wanted,
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
            fetchDirection: direction ?? null,
            fetchedCount: this.state().fetchedCount + 1,
          })
          // The app's callbacks come before #refetchIfAsked starts the
          // refetch queued during the fetch: that refetch may land at once,
          // and its callbacks must come after these. A callback that removes
          // the query, or clears the cache on a sign-out, leaves no refetch
          // to start and no gc to schedule (see #destroyed).
          this.#callbacks.success(
            {
              queryKey: this.key,
              queryHash: this.queryHash,
              state: this.state(),
              meta,
            },
            data,
          )
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
            fetchedCount: state.fetchedCount + 1,
          }))
          this.#callbacks.error(
            {
              queryKey: this.key,
              queryHash: this.queryHash,
              state: this.state(),
              meta,
            },
            err,
          )
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

  // Refetches the query with `args` on behalf of `by`, which is one of:
  // - the first component that wants the query fetched, for an invalidation;
  // - a component itself, by its refetch() (byHand);
  // - 'client', for fetchQuery() with cancelRefetch.
  // The fetch in flight may predate the reason. With data, it is replaced.
  // With none yet, it is let land and show, and the query is fetched once
  // more after it (see #refetchIfAsked), however many refetches are asked
  // for meanwhile. Whoever asks gets that refetch's promise, and a 'client'
  // hands its queryFn over for the retries to come, like a 'client' that
  // joins does.
  refetch(
    args: FetchArgs<TData, TError, TQueryFnData>,
    {
      by,
      byHand = false,
    }: {
      by: Asker<TData, TError, TQueryFnData>
      byHand?: boolean
    },
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
        clientArgs: undefined,
        byHand: undefined,
      }
    }

    if (by === 'client') {
      running.queuedRefetch.clientArgs = args
      running.lastAsked = { by, queryFn: args.queryFn }
    } else if (byHand) {
      running.queuedRefetch.byHand = by
    }

    return running.queuedRefetch.outcome.promise
  }

  // Without a structuralSharing setting the data is stored as is: which one
  // a write uses is the client's to resolve. A write counts in
  // InternalQueryState.fetchedCount, unless it's a `seed`: initialData, which
  // nothing fetched.
  setData(
    data: TData,
    {
      updatedAt = Date.now(),
      structuralSharing = false,
      seed = false,
    }: {
      updatedAt?: number
      structuralSharing?: StructuralSharingValue<TData>
      seed?: boolean
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
      fetchedCount: seed ? state.fetchedCount : state.fetchedCount + 1,
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
    this.#destroyed = true
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
    // failed shows its error again, and which way the fetch that failed went,
    // as in TanStack. Data and the stale mark aren't the fetch's to put back:
    // they stay as written meanwhile, so an invalidation made during the
    // fetch still holds.
    this.#state.update((state) => ({
      ...state,
      status: before.status,
      error: before.error,
      failureCount: before.failureCount,
      failureReason: before.failureReason,
      fetchDirection: before.fetchDirection,
      isFetching: false,
    }))
    inFlight.removeTask()
  }

  // Runs the refetch queued after the fetch that just ended (see
  // #queuedRefetchArgs), unless an attempt that started over began after the
  // refetch was last asked for: then all the data the fetch lands with was
  // read after the reason for the refetch (see InFlightFetch.refetchAsked).
  // A query destroyed meanwhile, by a callback of the app that heard of the
  // fetch, refetches nothing. Whoever asked gets the refetch's outcome, or
  // the fetch's.
  #refetchIfAsked(inFlight: InFlightFetch<TData, TError, TQueryFnData>): void {
    const queued = inFlight.queuedRefetch

    if (!queued) return

    const asked =
      inFlight.refetchAsked && !this.#destroyed
        ? this.#queuedRefetchArgs(queued)
        : null

    queued.outcome.resolve(
      asked
        ? this.fetch(asked.args, { by: asked.by })
        : inFlight.outcome.promise,
    )
  }

  // What the queued refetch runs with, and who it's made for, from the
  // first of these that there is:
  // 1. the args of the last 'client' that asked;
  // 2. the component that asked by hand, while it still shows the query,
  //    enabled or not: how its refetch() would refetch the query;
  // 3. the first component that wants the query fetched: how an
  //    invalidation would refetch it.
  // With none of them, the refetch is dropped: an invalidation leaves alone
  // a query that only disabled components show.
  #queuedRefetchArgs({
    clientArgs,
    byHand,
  }: QueuedRefetch<TData, TError, TQueryFnData>): {
    args: FetchArgs<TData, TError, TQueryFnData>
    by: Asker<TData, TError, TQueryFnData>
  } | null {
    if (clientArgs) return { args: clientArgs, by: 'client' }

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
  // asked: fetch() would drop the refetch anyway. A destroyed query refetches
  // nothing.
  #refetchOn(option: 'refetchOnWindowFocus' | 'refetchOnReconnect'): void {
    if (this.#inFlight || this.#destroyed) return

    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (!options || options[option] === false) continue

      if (options[option] === 'always' || this.shouldFetch(options.staleTime)) {
        this.fetch(options, { by: observer })

        return
      }
    }
  }

  // The queryFn for each request of a fetch after its first, a retry's first
  // request included, from the first of these that there is:
  // 1. the first observer that wants the query fetched now, the one that
  //    refetchIfActive picks;
  // 2. whoever asked for the fetch last (see InFlightFetch.lastAsked), while
  //    it still asks for this query (see QuerySubscriber.asksFor): a
  //    'client' always does; a component does whether enabled or not, and
  //    even once it went away, but not while it is unlisted. A component
  //    gives the queryFn that its options give now (see
  //    QuerySubscriber.refetchOptions), or, while they give none (they
  //    throw, or its effects haven't moved it to this query yet), the one
  //    that it asked with;
  // 3. none: no request is made then (see FetchAttempt).
  // Not simply the queryFn the fetch started with: a queryFn may read its
  // key's value only when it runs, like `() => api(this.id())` does, and by
  // then its component may have moved on to another key, or the key to
  // another place in an injectQueries list, whose queryFn reads another
  // signal. `wanted` is false once the component the queryFn came from went
  // away: its queryFn still makes the rest of a fetch that runs on without
  // it, such as the next page, but no retry, like when the last observer
  // leaves (see removeObserver).
  #nextQueryFn(inFlight: InFlightFetch<TData, TError, TQueryFnData>): {
    queryFn: QueryFunction<TQueryFnData>
    wanted: boolean
  } | null {
    for (const observer of this.#observers) {
      const options = observer.fetchOptions()

      if (options) return { queryFn: options.queryFn, wanted: true }
    }

    const { by, queryFn } = inFlight.lastAsked

    if (by === 'client') return { queryFn, wanted: true }

    return by.asksFor(this.queryHash)
      ? {
          queryFn: by.refetchOptions()?.queryFn ?? queryFn,
          wanted: by.fetches(this.queryHash),
        }
      : null
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
  // fetch of it ends, when data is written into it by hand. Also when its
  // gcTime changes, so the countdown starts over with the new one.
  #scheduleGc(): void {
    this.#clearGcTimer()

    // A destroyed query is out of the cache already. While observed, the
    // query is in use: the last observer leaving calls this again. Infinity,
    // or a gcTime no timer can hold, keeps the query until something removes
    // it: a browser would run the timer at once.
    if (
      this.#destroyed ||
      this.#observers.size > 0 ||
      !isValidTimeout(this.#gcTime)
    ) {
      return
    }

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
