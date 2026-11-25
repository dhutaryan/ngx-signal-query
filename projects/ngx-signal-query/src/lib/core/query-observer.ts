import {
  type EffectCleanupRegisterFn,
  type EffectRef,
  type Injector,
  type Signal,
  NgZone,
  computed,
  effect,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core'

import { pageVisibility } from './browser-events'
import { startPolling } from './polling'
import { QueryClient } from './query-client'
import {
  applyInitialData,
  type FetchArgs,
  type InternalQueryState,
  type Query,
  type QuerySubscriber,
} from './query'
import type {
  DefaultedQueryOptions,
  PlaceholderDataFunction,
  QueryFunction,
  QueryKey,
  QueryOptions,
  QueryResult,
  QueryStatus,
} from './types'
import { hashKey, isValidTimeout } from './utils'

/**
 * The options an observer is created with: a query's options whose queryFn
 * gives TQueryFnData, which is the data itself for a plain query and one
 * page for an infinite query. The layer that creates the observer may add
 * fields of its own, like an infinite query's page options.
 *
 * @internal
 */
export type ObserverOptions<TData, TError, TQueryFnData> = Omit<
  QueryOptions<TData, TError>,
  'queryFn'
> & { queryFn: QueryFunction<TQueryFnData> }

/**
 * An observer's options with the client's defaults filled in.
 *
 * @internal
 */
export type DefaultedObserverOptions<TOptions, TData, TError, TQueryFnData> =
  TOptions & DefaultedQueryOptions<TData, TError, TQueryFnData>

/**
 * What a fetch made on behalf of an observer runs with: FetchArgs whose
 * retry policy and structuralSharing are always set, from the client's
 * defaults where the options leave them out.
 *
 * @internal
 */
export type ObserverFetchArgs<TData, TError, TQueryFnData> = FetchArgs<
  TData,
  TError,
  TQueryFnData
> &
  Pick<
    DefaultedQueryOptions<TData, TError, TQueryFnData>,
    'retry' | 'retryDelay' | 'structuralSharing'
  >

/**
 * Builds the fetch args from an observer's live options, for every fetch
 * made on its behalf: those it asks for and those the query makes for it.
 * injectQuery and injectQueries pass fetchArgsOf; an infinite query adds
 * its behavior, which fetches the pages.
 *
 * @internal
 */
export type FetchArgsBuilder<TOptions, TData, TError, TQueryFnData> = (
  options: DefaultedObserverOptions<TOptions, TData, TError, TQueryFnData>,
) => ObserverFetchArgs<TData, TError, TQueryFnData>

/**
 * One observed query: its reactive {@link QueryResult} and a `destroy()` that
 * ends the observation (unregisters from the query, stops polling). For a
 * layer built on the observer, such as an infinite query's: the state of the
 * observed query, its options, and `asObserver`, which runs `act` on its
 * behalf with the live options (see createQueryObserver).
 *
 * @internal
 */
export interface QueryObserver<
  TData,
  TError = Error,
  TQueryFnData = TData,
  TOptions = ObserverOptions<TData, TError, TQueryFnData>,
> {
  result: QueryResult<TData, TError>
  destroy: () => void
  state: Signal<InternalQueryState<TData, TError>>
  /**
   * The options that the effects go by, with the defaults filled in. Reading
   * it throws while optionsFn throws.
   */
  options: Signal<
    DefaultedObserverOptions<TOptions, TData, TError, TQueryFnData>
  >
  /**
   * Gives what `act` gives, or, while the observer is unlisted (see
   * createQueryObserver), undefined without running it.
   */
  asObserver: <R>(
    act: (on: {
      q: Query<TData, TError, TQueryFnData>
      options: DefaultedObserverOptions<TOptions, TData, TError, TQueryFnData>
      args: ObserverFetchArgs<TData, TError, TQueryFnData>
      by: QuerySubscriber<TData, TError, TQueryFnData>
    }) => R,
  ) => R | undefined
}

/**
 * Observes a single query and exposes its state as signals — the engine behind
 * {@link injectQuery} and {@link injectQueries}.
 *
 * Nothing is evaluated on creation: `optionsFn` is first called by the first
 * effect run or the first read of a result signal, so it may depend on state
 * that isn't ready while the owner is being constructed (inputs, fields
 * declared later).
 *
 * Effects are created on `injector` with `manualCleanup` so the observer can be
 * torn down on its own via `destroy()`, independently of the injector's
 * lifetime (a component may drop one query out of many). In a component
 * injector they run as view effects, elsewhere as root effects — the same as
 * `effect()` called directly in that context.
 *
 * Every fetch made on behalf of the observer runs with what `fetchArgs` builds
 * from the live options (see FetchArgsBuilder): what `liveOptionsFn` gives
 * right now, or, without it, what `optionsFn` gives. An owner whose
 * `optionsFn` may lag behind passes `liveOptionsFn`. injectQueries does: it
 * hands each query's observer its options from an effect, which runs only at
 * change detection.
 *
 * While `liveOptionsFn` gives null, the observer is unlisted: its owner asks
 * for no query with it, like injectQueries for a key that has left its list,
 * and nothing is fetched on its behalf.
 *
 * @internal
 */
export function createQueryObserver<
  TData,
  TError = Error,
  TQueryFnData = TData,
  TOptions extends ObserverOptions<TData, TError, TQueryFnData> =
    ObserverOptions<TData, TError, TQueryFnData>,
>(
  optionsFn: () => TOptions,
  injector: Injector,
  fetchArgs: FetchArgsBuilder<TOptions, TData, TError, TQueryFnData>,
  liveOptionsFn?: () => TOptions | null,
): QueryObserver<TData, TError, TQueryFnData, TOptions> {
  const client = injector.get(QueryClient)
  const cache = client.getQueryCache()

  // Every effect is registered here so destroy() covers all of them.
  const refs: EffectRef[] = []
  const track = (fn: (onCleanup: EffectCleanupRegisterFn) => void): void => {
    refs.push(effect(fn, { injector, manualCleanup: true }))
  }

  // Resolves config defaults (staleTime, gcTime) in one place instead of
  // scattering the logic across effects. The defaults don't depend on what
  // queryFn gives, so the client fills them in for any kind of query. Its
  // types know only a plain query, whose queryFn gives the data itself: the
  // options go in cast to a plain query's, and come back with their own type,
  // the defaults filled in.
  const withDefaults = (
    options: TOptions,
  ): DefaultedObserverOptions<TOptions, TData, TError, TQueryFnData> =>
    client.defaultQueryOptions(
      options as unknown as QueryOptions<TData, TError>,
    ) as unknown as DefaultedObserverOptions<
      TOptions,
      TData,
      TError,
      TQueryFnData
    >

  // Single source of truth for the options that the effects go by.
  const defaultedOptions = computed(() => withDefaults(optionsFn()))

  // The live options, with the defaults filled in, which every fetch goes
  // by: null while the observer is unlisted. Without liveOptionsFn, this is
  // defaultedOptions itself.
  const live: Signal<ReturnType<typeof defaultedOptions> | null> = liveOptionsFn
    ? computed(() => {
        const options = liveOptionsFn()

        return options === null ? null : withDefaults(options)
      })
    : defaultedOptions

  // The observer holds its query in several places, each for its own reader:
  // - switched: the query that the key or follow effect last moved it to;
  // - query: the observed query, which the result signals read: switched,
  //   or, before the key effect first runs, the current key's query,
  //   resolved on the spot;
  // - shown: the query the subscriber is registered with, which catches up
  //   with query when the subscriber effect runs;
  // - cached: the cache's entry for the key right now, undefined after
  //   removeQueries;
  // - since: the query that resolve() turned the observer to last, with its
  //   fetchedCount at that point: isFetchedAfterMount's baseline.
  //   switchedSince holds `since` as it was at the last switch.

  // A query the observer turned to, and how many times something had landed
  // in it by then.
  type TurnedTo = {
    q: Query<TData, TError, TQueryFnData>
    fetchedCount: number
  }

  // The query the observer turned to last: isFetchedAfterMount tells from it
  // whether something has landed in the query since (see
  // InternalQueryState.fetchedCount).
  const since = signal<TurnedTo | undefined>(undefined)

  // `since` as it was when the effects last switched the observer to a query
  // (see switchTo). The observer may turn to another query before the
  // effects move it there, as refetch() does for the next key. If the key
  // comes back before they do, they never left the query they switched to,
  // so the observer goes on from this rather than starting over.
  let switchedSince: TurnedTo | undefined

  // Resolves the query for a key, seeding one with no data yet with the
  // initialData of `options` (see applyInitialData). `options` are those
  // that the effects go by, unless a fetch made on the observer's behalf
  // passes the live ones that it fetches with, like asObserver and the poll
  // do. It writes signals (the cache's entries, the query's state, `since`),
  // so callers run it untracked: reached from a computed, a tracked write
  // throws NG0600.
  //
  // When it gives another query than last time (the first one, a new key's,
  // a key coming back, a new entry after removeQueries or clear()), the
  // observer turns to that query: `since` records it with its fetchedCount
  // at that point, isFetchedAfterMount's baseline. For the query the effects
  // last switched to, `since` takes back the baseline noted at the switch
  // (switchedSince). Each fetch that the observer asks for resolves its
  // query here first, so a response that comes back at once counts as
  // landing after the baseline, however late the effects catch up.
  const resolve = (
    key: QueryKey,
    options: ReturnType<typeof defaultedOptions> = untracked(defaultedOptions),
  ): Query<TData, TError, TQueryFnData> => {
    const q = cache.getOrCreate<TData, TError, TQueryFnData>(
      key,
      options.gcTime,
    )

    applyInitialData(q, options)

    if (untracked(since)?.q !== q) {
      since.set(
        switchedSince?.q === q
          ? switchedSince
          : { q, fetchedCount: q.state().fetchedCount },
      )
    }

    return q
  }

  // The query the observer last switched to, by the key effect or the follow
  // effect below; unset until the key effect first runs.
  const switched = signal<Query<TData, TError, TQueryFnData> | undefined>(
    undefined,
  )

  // The observed query, resolved lazily: on the first read of a result signal
  // or the first effect run, whichever comes first. Resolving it calls
  // optionsFn, which may read inputs or fields that don't exist yet while the
  // owner is being constructed. A read before the key effect's first run
  // resolves the current key on the spot, so it already sees cached data and
  // initialData; from then on the key and follow effects switch queries.
  //
  // Such a read may put a new query in the cache in the middle of a
  // computation: say a parent's computed reads injectIsFetching(), then this
  // result for the first time. That computed doesn't hear of the new entry,
  // so the cache tells its readers again once the computation is over.
  const query = computed(
    () =>
      switched() ??
      untracked(() => {
        const key = defaultedOptions().queryKey
        const created = cache.get(key) === undefined
        const q = resolve(key)

        if (created) cache.notifyLater()

        return q
      }),
  )

  // Data of the last query that had any, fed to the placeholderData function
  // on a switch: a key change, or the key coming back after a removal
  // (mirrors TanStack's lastQueryWithDefinedData). Captured synchronously
  // before the switch so it can't miss a just-resolved value.
  const lastData = signal<TData | undefined>(undefined)

  // Switches the observer to q, first keeping the data of the query it
  // leaves for the placeholderData function. q comes from resolve(), which
  // has just turned the observer to it, so `since` is q's.
  const switchTo = (q: Query<TData, TError, TQueryFnData>): void => {
    untracked(() => {
      const prev = switched()

      if (prev && prev !== q && prev.state().data !== undefined) {
        lastData.set(prev.state().data)
      }
    })
    switched.set(q)
    switchedSince = untracked(since)
  }

  // Key effect: moves the observer to the query of the key that the options
  // give.
  track(() => {
    const key = defaultedOptions().queryKey

    switchTo(untracked(() => resolve(key)))
  })

  // The query cached under the key right now, read reactively: undefined once
  // removeQueries drops it, and the new entry once something brings the key
  // back.
  const cached = computed(() =>
    cache.find<TData, TError, TQueryFnData>(defaultedOptions().queryKey),
  )

  // Follow effect: moves the observer to a new entry for its key. After
  // removeQueries the observer keeps the query the cache dropped and shows
  // what it had: the removal refetches nothing, which matches TanStack. On
  // the next run of optionsFn, the key effect resolves the key into a new
  // entry, and the fetch effect fetches it. Whatever brings the key back
  // before that, like a write, a refetch, a poll or another component, this
  // effect moves the observer there the way a key change does, and resolve()
  // seeds initialData into an entry still pending.
  track(() => {
    const entry = cached()

    if (!entry || entry === untracked(switched)) return

    switchTo(untracked(() => resolve(entry.key)))
  })

  // An untracked read of live that gives null instead of throwing, for the
  // library's own reads made from someone else's call, like an
  // invalidation's: null while the options throw, and while the observer is
  // unlisted. The owner's effects still report such an error to Angular, and
  // a read like this mustn't fail the caller or interrupt other queries.
  const liveOptions = (): ReturnType<typeof defaultedOptions> | null => {
    try {
      return untracked(live)
    } catch {
      return null
    }
  }

  // How this observer would refetch q by hand, like refetch() does, enabled
  // or not, from the live options; null while there are none (see
  // liveOptions), or once the key has moved on. Before the key effect above
  // catches up, queryFn already fetches the next query's data, so q must not
  // be fetched with it.
  const refetchOptionsFor = (
    q: Query<TData, TError, TQueryFnData>,
  ): ReturnType<
    QuerySubscriber<TData, TError, TQueryFnData>['fetchOptions']
  > => {
    const options = liveOptions()

    if (!options || hashKey(options.queryKey) !== q.queryHash) return null

    const { staleTime, refetchOnWindowFocus, refetchOnReconnect } = options

    return {
      ...fetchArgs(options),
      staleTime,
      refetchOnWindowFocus,
      refetchOnReconnect,
    }
  }

  // How this observer would fetch q right now, and when it wants q
  // refetched: refetchOptionsFor(q) while it is enabled, null while it is
  // disabled. Polling goes by it, and so does every fetch that the query
  // makes for this observer through the subscriber below:
  // - the refetch that invalidateQueries() or refetchQueries() asks for;
  // - a refetch on window focus or on reconnect;
  // - the refetch an invalidation queues during a first load;
  // - the queryFn of each request after a fetch's first, a retry's included.
  // What the observer is asked for by hand, refetch(), fetchNextPage() and
  // fetchPreviousPage(), fetches whether it is enabled or not, and so do the
  // refetch that refetch() queues and the later requests of a fetch that the
  // observer asked for last (see Query#nextQueryFn).
  const fetchOptionsFor = (
    q: Query<TData, TError, TQueryFnData>,
  ): ReturnType<
    QuerySubscriber<TData, TError, TQueryFnData>['fetchOptions']
  > => (liveOptions()?.enabled === false ? null : refetchOptionsFor(q))

  // The query the subscriber below is registered with, set by the subscriber
  // effect. Not query(): on a key change, that is the next query before
  // the effect moves the subscriber there, and on Angular 19 effects outside
  // components may run in between, such as one that invalidates the query
  // being left: answered with the next query's options, it would get the next
  // key's data.
  let shown: Query<TData, TError, TQueryFnData> | undefined

  // Set once destroy() has run: the observer shows no query any more, so its
  // queryFn fetches none on the handle's behalf (see subscriber.fetches).
  let destroyed = false

  // The handle this observer registers with the query it shows
  // (Query#addObserver), moved from query to query along with the observer.
  // Each fetch the observer asks for passes it as `by`, so the query knows
  // who asks.
  const subscriber: QuerySubscriber<TData, TError, TQueryFnData> = {
    fetchOptions: () => (shown ? fetchOptionsFor(shown) : null),
    refetchOptions: () => (shown ? refetchOptionsFor(shown) : null),
    // Reads live itself, not through liveOptions(), which gives null both
    // while the options throw and while the observer is unlisted: asksFor
    // answers the two differently (see QuerySubscriber.asksFor).
    asksFor: (queryHash) => {
      try {
        const options = untracked(live)

        return options !== null && hashKey(options.queryKey) === queryHash
      } catch {
        return shown?.queryHash === queryHash
      }
    },
    fetches: (queryHash) => !destroyed && subscriber.asksFor(queryHash),
    structuralSharing: () => liveOptions()?.structuralSharing,
  }

  // Runs `act` on behalf of this observer, on the query that the live options
  // ask for: `act` gets that query, the options, the fetch args built from
  // them, and the subscriber that tells the query who asks. The key, the
  // initialData that a new query is seeded with and the fetch args all come
  // from one read of the options, so a fetch can't go to another key's
  // query, nor seed its query from older options, whatever order the effects
  // run in. While the observer is unlisted, it runs nothing and gives
  // undefined. Untracked, like the client's methods: called from an effect,
  // it mustn't make the effect depend on the options or on the query.
  const asObserver: QueryObserver<
    TData,
    TError,
    TQueryFnData,
    TOptions
  >['asObserver'] = (act) =>
    untracked(() => {
      const options = live()

      if (options === null) return undefined

      return act({
        q: resolve(options.queryKey, options),
        options,
        args: fetchArgs(options),
        by: subscriber,
      })
    })

  // Subscriber effect: registers the subscriber with the observed query,
  // query(), and moves it there on a switch. shown is the query it last
  // registered with.
  track((cleanup) => {
    const q = query()

    q.updateGcTime(untracked(defaultedOptions).gcTime)
    shown = q
    q.addObserver(subscriber)
    // Untracked, as Angular 20 runs cleanups anyway: Angular 19 runs them at
    // the start of the effect's next run, where what they read becomes a
    // dependency of the effect. Leaving q may cancel its request, which reads
    // and writes q's state: that write, or any later one to q, would run the
    // effect again, and that run's cleanup would leave the query the observer
    // has just moved to.
    //
    // TODO: drop the untracked once the minimum supported Angular is 20.
    cleanup(() => untracked(() => q.removeObserver(subscriber)))
  })

  // Memoized so options re-evaluations that leave the flag alone don't wake
  // the fetch and polling effects.
  const enabled = computed(() => defaultedOptions().enabled !== false)

  // Fetch effect: fetches when the observed query switches (key change) or
  // when it becomes enabled, not on every re-evaluation of the options.
  // defaultQueryOptions() builds a fresh object each time, so tracking it
  // whole would refetch stale data whenever any signal read in optionsFn
  // changes, even one unrelated to the key. queryFn, staleTime and the retry
  // policy only parameterise the fetch and are read untracked (TanStack's
  // shouldFetchOptionally). Invalidation isn't a trigger: invalidateQueries()
  // refetches each active query once itself. A query it skipped (unobserved,
  // or its observers disabled) stays invalidated, so it fetches here once
  // observed or enabled: shouldFetch sees isInvalidated. A fetch from before
  // the invalidation that still runs is joined, not replaced; isInvalidated
  // outlives it, so the next trigger refetches.
  track(() => {
    query()

    if (!enabled()) return

    asObserver(({ q, options, args, by }) => {
      if (q.shouldFetch(options.staleTime)) q.fetch(args, { by })
    })
  })

  // The polling interval this observer asks for, or false for none. Memoized,
  // so the polling effect wakes only when the value changes. The function form
  // is resolved against the query's state, so it is re-resolved on every
  // update of it, and a switch to false stops polling. 0 means no polling, and
  // so does a value no timer can hold: the timer would fire over and over.
  const interval = computed(() => {
    const { refetchInterval } = defaultedOptions()
    const value =
      typeof refetchInterval === 'function'
        ? refetchInterval({ state: query().state() })
        : refetchInterval

    return isValidTimeout(value) && value > 0 ? value : false
  })

  // Whether the user can see the page right now; polls wait while they can't.
  const pageVisible = runInInjectionContext(injector, pageVisibility)
  // Angular's zone, which the polling timer stays out of.
  const zone = injector.get(NgZone)

  // Polling effect: refetches on an interval, independent of staleTime. The
  // timer restarts when the observed query switches, or when enabled or the
  // interval changes, like TanStack's setOptions does. It doesn't restart on
  // every re-evaluation of the options: defaultQueryOptions() builds a fresh
  // object each time, so tracking it whole would restart the timer whenever
  // any signal read in optionsFn changes. One that changes faster than the
  // interval would keep it from ever firing.
  //
  // Each poll comes ms after the query's last update, as in TanStack, whose
  // observer restarts its timer on every update of the query. So a fetch made
  // for any reason (another observer's poll, refetch(), an invalidation) or a
  // cache write pushes the next poll back. However many observers poll a key,
  // it's fetched once per interval. Unlike TanStack, the wait counts from
  // updatedAt, the last response or cache write, not from any change of
  // state: a fetch that starts or fails doesn't push it back.
  track((onCleanup) => {
    const q = query()

    if (!enabled()) return

    const ms = interval()

    if (!ms) return

    // Fetches the key with the live options as they are when it fires, which
    // may have changed since the effect ran. The key's entry is q, unless
    // removeQueries dropped it: then the poll puts the key back, as TanStack's
    // observer does before every fetch, and the follow effect moves this
    // observer there.
    //
    // While the page is hidden, the poll is skipped unless those options ask
    // to keep polling there, as in TanStack: nobody sees the data, and coming
    // back refetches it if it's stale. The timer keeps its schedule, so the
    // poll due next goes out once the page shows again.
    const poll = (): void => {
      const options = fetchOptionsFor(q)
      const current = liveOptions()

      if (!options || !current) return

      if (current.refetchIntervalInBackground || pageVisible()) {
        resolve(q.key, current).fetch(options, { by: subscriber })
      }
    }

    // The timer waits outside Angular's zone: with zone.js, a timer pending
    // there would keep the app from ever counting as stable. Each poll runs
    // outside it too, as a refetch asked for from outside the zone does: what
    // it changes still shows, since Angular renders a signal wherever it
    // changes. Only an app that turns that off with the deprecated
    // ignoreChangesOutsideZone doesn't see that a poll is in flight.
    onCleanup(
      zone.runOutsideAngular(() =>
        startPolling(ms, () => q.state().updatedAt, poll),
      ),
    )
  })

  // Placeholder layer: while the query is pending with no data, present
  // placeholderData as already-successful data. Purely presentational — the
  // cache entry stays 'pending' and the fetch proceeds, so isFetching keeps
  // reporting the real request and the placeholder is dropped on resolve.
  const resolved = computed<{
    data: TData | undefined
    status: QueryStatus
    isPlaceholderData: boolean
  }>(() => {
    const state = query().state()
    const { placeholderData } = defaultedOptions()

    if (
      placeholderData !== undefined &&
      state.data === undefined &&
      state.status === 'pending'
    ) {
      const data =
        typeof placeholderData === 'function'
          ? (placeholderData as PlaceholderDataFunction<TData>)(lastData())
          : placeholderData

      if (data !== undefined) {
        return { data, status: 'success', isPlaceholderData: true }
      }
    }

    return { data: state.data, status: state.status, isPlaceholderData: false }
  })

  const result: QueryResult<TData, TError> = {
    data: computed(() => resolved().data),
    // Read from the query, unlike data(): a placeholder isn't the query's data
    // and has no time, so this stays 0 while one shows. The query stamps
    // updatedAt only along with data, so it's 0 while there's none.
    dataUpdatedAt: computed(() => query().state().updatedAt),
    status: computed(() => resolved().status),
    error: computed(() => query().state().error),
    isFetching: computed(() => query().state().isFetching),
    // A fetch in flight with no data to show: the first one, or a new attempt
    // after a failure. An active placeholder counts as data — the UI shows it,
    // not a loading state.
    isLoading: computed(
      () => query().state().isFetching && resolved().status === 'pending',
    ),
    isPending: computed(() => resolved().status === 'pending'),
    isSuccess: computed(() => resolved().status === 'success'),
    isError: computed(() => resolved().status === 'error'),
    isPlaceholderData: computed(() => resolved().isPlaceholderData),
    isFetched: computed(() => query().state().fetchedCount > 0),
    // query() first: a first read resolves the query, which sets `since`.
    // Until the effects catch up with a query the observer has turned to,
    // the observed query has nothing landed since.
    isFetchedAfterMount: computed(() => {
      const q = query()
      const turnedTo = since()

      return turnedTo?.q === q && q.state().fetchedCount > turnedTo.fetchedCount
    }),
    failureCount: computed(() => query().state().failureCount),
    failureReason: computed(() => query().state().failureReason),
    // Force a fresh fetch regardless of staleTime and enabled (explicit user
    // intent — get current data): a fetch in flight is replaced, or, with no
    // data yet, let land first (see Query#refetch). However the fetch ends,
    // the signals show it, so the promise resolves with their data and error
    // and never rejects. While the observer is unlisted, nothing is fetched
    // (see asObserver), and it resolves with them right away. While the
    // options throw, it throws their error, like mutate() does.
    refetch: () =>
      Promise.resolve(
        asObserver(({ q, args, by }) => q.refetch(args, { by, byHand: true })),
      )
        .catch(() => undefined)
        .then(() => ({ data: result.data(), error: result.error() })),
  }

  return {
    result,
    destroy: () => {
      destroyed = true
      refs.forEach((ref) => ref.destroy())
    },
    state: computed(() => query().state()),
    options: defaultedOptions,
    asObserver,
  }
}
