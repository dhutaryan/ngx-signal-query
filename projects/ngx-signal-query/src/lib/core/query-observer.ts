import {
  type EffectCleanupRegisterFn,
  type EffectRef,
  type Injector,
  computed,
  effect,
  signal,
  untracked,
} from '@angular/core'

import { startPolling } from './polling'
import { QueryClient } from './query-client'
import type { Query, QuerySubscriber } from './query'
import type {
  PlaceholderDataFunction,
  QueryKey,
  QueryOptions,
  QueryResult,
  QueryStatus,
} from './types'
import { hashKey, isValidTimeout } from './utils'

/**
 * One observed query: its reactive {@link QueryResult} and a `destroy()` that
 * ends the observation (drops the cache observer, stops polling).
 *
 * @internal
 */
export interface QueryObserver<TData, TError = Error> {
  result: QueryResult<TData, TError>
  destroy: () => void
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
 * @internal
 */
export function createQueryObserver<TData, TError = Error>(
  optionsFn: () => QueryOptions<TData, TError>,
  injector: Injector,
): QueryObserver<TData, TError> {
  const client = injector.get(QueryClient)
  const cache = client.getQueryCache()

  // Every effect is registered here so destroy() covers all of them.
  const refs: EffectRef[] = []
  const track = (fn: (onCleanup: EffectCleanupRegisterFn) => void): void => {
    refs.push(effect(fn, { injector, manualCleanup: true }))
  }

  // Single source of truth for defaulted options; resolves config defaults
  // (staleTime, gcTime) once instead of scattering the logic across effects.
  const defaultedOptions = computed(() =>
    client.defaultQueryOptions(optionsFn()),
  )

  // Seed a fresh query (status 'pending', no data yet) with initialData so
  // it renders immediately as 'success'. Without an explicit
  // initialDataUpdatedAt the seed is treated as fetched right now, so
  // staleTime applies to it as it would to any other data (a staleTime of 0
  // still means "stale immediately" → background refetch). A function that
  // returns undefined has nothing to seed, so the query stays 'pending' and
  // fetches; it is asked again whenever the key is resolved while the query
  // is still pending, and seeds it if it has data by then, as in TanStack.
  const applyInitialData = (q: Query<TData, TError>): void => {
    const { initialData, initialDataUpdatedAt } = untracked(defaultedOptions)

    if (initialData === undefined || q.state().status !== 'pending') return

    const data =
      typeof initialData === 'function'
        ? (initialData as () => TData | undefined)()
        : initialData

    if (data === undefined) return

    const updatedAt =
      typeof initialDataUpdatedAt === 'function'
        ? initialDataUpdatedAt()
        : (initialDataUpdatedAt ?? Date.now())

    q.setData(data, { updatedAt })
  }

  // Resolves the query for a key, seeding a fresh one with initialData. It
  // writes signals (the cache's entries, the query's state), so callers run it
  // untracked: reached from a computed, a tracked write throws NG0600.
  const resolve = (key: QueryKey): Query<TData, TError> => {
    const q = cache.getOrCreate<TData, TError>(key)

    applyInitialData(q)

    return q
  }

  // The query the observer last switched to, by the key effect or the follow
  // effect below; unset until the key effect first runs.
  const switched = signal<Query<TData, TError> | undefined>(undefined)

  // The observed query, resolved lazily: on the first read of a result signal
  // or the first effect run, whichever comes first. Resolving it calls
  // optionsFn, which may read inputs or fields that don't exist yet while the
  // owner is being constructed. A read before the key effect's first run
  // resolves the current key on the spot, so it already sees cached data and
  // initialData; from then on the key and follow effects switch queries.
  const query = computed(
    () => switched() ?? untracked(() => resolve(defaultedOptions().queryKey)),
  )

  // Data of the last query that had any, fed to the placeholderData function
  // on a switch: a key change, or the key coming back after a removal
  // (mirrors TanStack's lastQueryWithDefinedData). Captured synchronously
  // before the switch so it can't miss a just-resolved value.
  const lastData = signal<TData | undefined>(undefined)

  // Switches the observer to q, first keeping the data of the query it
  // leaves for the placeholderData function.
  const switchTo = (q: Query<TData, TError>): void => {
    untracked(() => {
      const prev = switched()

      if (prev && prev !== q && prev.state().data !== undefined) {
        lastData.set(prev.state().data)
      }
    })
    switched.set(q)
  }

  track(() => {
    const key = defaultedOptions().queryKey

    switchTo(untracked(() => resolve(key)))
  })

  // The query cached under the key right now, read reactively: undefined once
  // removeQueries drops it, and the new entry once something brings the key
  // back.
  const cached = computed(() =>
    cache.find<TData, TError>(defaultedOptions().queryKey),
  )

  // After removeQueries the observer keeps the query the cache dropped and
  // shows what it had: nothing here brings the key back, as in TanStack, where
  // a removal doesn't refetch. Whatever does bring it back (a write, a refetch,
  // another component, a poll), the observer follows it there as on a key
  // change: resolve() seeds initialData into an entry still pending. Without
  // this, it would see the new entry only once its options change.
  track(() => {
    const entry = cached()

    if (!entry || entry === untracked(switched)) return

    switchTo(untracked(() => resolve(entry.key)))
  })

  // How this observer would fetch q right now, from the live options; null
  // while it is disabled, or once the key has moved on. Before the key effect
  // above catches up, queryFn already fetches the next query's data, so q
  // must not be fetched with it. Both refetches made on our behalf go by it:
  // the invalidation one (through q's subscriber handle) and polling.
  const fetchOptionsFor = (
    q: Query<TData, TError>,
  ): ReturnType<QuerySubscriber<TData, TError>['fetchOptions']> => {
    const { queryKey, queryFn, retry, retryDelay, structuralSharing, enabled } =
      untracked(defaultedOptions)

    if (enabled === false || hashKey(queryKey) !== q.queryHash) {
      return null
    }

    return { queryFn, retry, retryDelay, structuralSharing }
  }

  track((cleanup) => {
    const q = query()
    const { gcTime } = untracked(defaultedOptions)

    if (gcTime !== undefined) {
      q.setGcTime(gcTime)
    }

    // This observer as q sees it.
    const subscriber: QuerySubscriber<TData, TError> = {
      fetchOptions: () => fetchOptionsFor(q),
      structuralSharing: () => untracked(defaultedOptions).structuralSharing,
    }

    q.addObserver(subscriber)
    cleanup(() => q.removeObserver(subscriber))
  })

  // Memoized so options re-evaluations that leave the flag alone don't wake
  // the fetch and polling effects.
  const enabled = computed(() => defaultedOptions().enabled !== false)

  // Fetch when the observed query switches (key change) or when it becomes
  // enabled — not on every re-evaluation of the options. defaultQueryOptions()
  // builds a fresh object each time, so tracking it whole would refetch stale
  // data whenever any signal read in optionsFn changes, even one unrelated to
  // the key. queryFn, staleTime and the retry policy only parameterise the
  // fetch and are read untracked (TanStack's shouldFetchOptionally).
  // Invalidation isn't a trigger: invalidateQueries() refetches each active
  // query once itself. A query it skipped (unobserved, or its observers
  // disabled) stays invalidated, so it fetches here once observed or enabled:
  // shouldFetch sees the flag.
  track(() => {
    query()

    if (!enabled()) return

    const {
      queryKey,
      queryFn,
      staleTime,
      retry,
      retryDelay,
      structuralSharing,
    } = untracked(defaultedOptions)

    untracked(() =>
      client.fetchQuery(queryKey, queryFn, {
        staleTime,
        retry,
        retryDelay,
        structuralSharing,
      }),
    )
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

  // Polling: refetch on an interval, independent of staleTime. The timer
  // restarts when the observed query switches, or when enabled or the interval
  // changes, as in TanStack's setOptions. It doesn't restart on every
  // re-evaluation of the options: defaultQueryOptions() builds a fresh object
  // each time, so tracking it whole would restart the timer whenever any
  // signal read in optionsFn changes. One that changes faster than the
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

    // Fetches the key with the options as they are when it fires, which may
    // have changed since the effect ran. The key's entry is q, unless
    // removeQueries dropped it: then the poll puts the key back, as TanStack's
    // observer does before every fetch, and the follow effect moves this
    // observer there.
    const poll = (): void => {
      const options = fetchOptionsFor(q)

      if (options) {
        resolve(q.key).fetch(options)
      }
    }

    onCleanup(startPolling(ms, () => q.state().updatedAt, poll))
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

  return {
    result: {
      data: computed(() => resolved().data),
      status: computed(() => resolved().status),
      error: computed(() => query().state().error as TError | null),
      isFetching: computed(() => query().state().isFetching),
      // First fetch in-flight: fetching with no resolved data yet. An active
      // placeholder counts as data — the UI shows it, not a loading state.
      isLoading: computed(
        () => query().state().isFetching && resolved().status === 'pending',
      ),
      isPending: computed(() => resolved().status === 'pending'),
      isSuccess: computed(() => resolved().status === 'success'),
      isError: computed(() => resolved().status === 'error'),
      isPlaceholderData: computed(() => resolved().isPlaceholderData),
      failureCount: computed(() => query().state().failureCount),
      failureReason: computed(
        () => query().state().failureReason as TError | null,
      ),
      // Force a fresh fetch regardless of staleTime, cancelling any in-flight
      // request (explicit user intent — get current data).
      refetch: () => {
        const { queryKey, queryFn, retry, retryDelay, structuralSharing } =
          untracked(defaultedOptions)

        client.fetchQuery(queryKey, queryFn, {
          staleTime: 0,
          retry,
          retryDelay,
          structuralSharing,
          cancelRefetch: true,
        })
      },
    },
    destroy: () => refs.forEach((ref) => ref.destroy()),
  }
}
