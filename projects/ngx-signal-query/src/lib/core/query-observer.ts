import {
  type EffectCleanupRegisterFn,
  type EffectRef,
  type Injector,
  computed,
  effect,
  signal,
  untracked,
} from '@angular/core'

import { QueryClient } from './query-client'
import type { Query, QuerySubscriber } from './query'
import type {
  PlaceholderDataFunction,
  QueryKey,
  QueryOptions,
  QueryResult,
  QueryStatus,
} from './types'
import { hashKey } from './utils'

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
  // still means "stale immediately" → background refetch).
  const applyInitialData = (q: Query<TData, TError>): void => {
    const { initialData, initialDataUpdatedAt } = untracked(defaultedOptions)

    if (initialData === undefined || q.state().status !== 'pending') return

    const data =
      typeof initialData === 'function'
        ? (initialData as () => TData)()
        : initialData
    const updatedAt =
      typeof initialDataUpdatedAt === 'function'
        ? initialDataUpdatedAt()
        : (initialDataUpdatedAt ?? Date.now())

    q.setData(data, updatedAt)
  }

  // Resolves the query for a key, seeding a fresh one with initialData. It
  // writes signals (the cache's entries, the query's state), so callers run it
  // untracked: reached from a computed, a tracked write throws NG0600.
  const resolve = (key: QueryKey): Query<TData, TError> => {
    const q = cache.getOrCreate<TData, TError>(key)

    applyInitialData(q)

    return q
  }

  // The query the key effect below last switched to; unset until it first runs.
  const switched = signal<Query<TData, TError> | undefined>(undefined)

  // The observed query, resolved lazily: on the first read of a result signal
  // or the first effect run, whichever comes first. Resolving it calls
  // optionsFn, which may read inputs or fields that don't exist yet while the
  // owner is being constructed. A read before the key effect's first run
  // resolves the current key on the spot, so it already sees cached data and
  // initialData; from then on only the key effect switches queries.
  const query = computed(
    () => switched() ?? untracked(() => resolve(defaultedOptions().queryKey)),
  )

  // Data of the last query that had any, fed to the placeholderData function
  // on key change (mirrors TanStack's lastQueryWithDefinedData). Captured
  // synchronously before the switch so it can't miss a just-resolved value.
  const lastData = signal<TData | undefined>(undefined)

  track(() => {
    const key = defaultedOptions().queryKey
    const q = untracked(() => resolve(key))

    untracked(() => {
      const prev = switched()

      if (prev && prev !== q && prev.state().data !== undefined) {
        lastData.set(prev.state().data)
      }
    })
    switched.set(q)
  })

  track((cleanup) => {
    const q = query()
    const { gcTime } = untracked(defaultedOptions)

    if (gcTime !== undefined) {
      q.setGcTime(gcTime)
    }

    // This observer as q sees it: how to fetch q for us, from the live
    // options. Once the key has moved on (before the key effect above catches
    // up), queryFn already fetches the next query's data, so q must not be
    // fetched with it.
    const subscriber: QuerySubscriber<TData, TError> = {
      fetchOptions: () => {
        const { queryKey, queryFn, retry, retryDelay, enabled } =
          untracked(defaultedOptions)

        if (enabled === false || hashKey(queryKey) !== q.queryHash) {
          return null
        }

        return { queryFn, retry, retryDelay }
      },
    }

    q.addObserver(subscriber)
    cleanup(() => q.removeObserver(subscriber))
  })

  // Memoized so options re-evaluations that leave the flag alone don't wake
  // the fetch effect.
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

    const { queryKey, queryFn, staleTime, retry, retryDelay } =
      untracked(defaultedOptions)

    untracked(() =>
      client.fetchQuery(queryKey, queryFn, { staleTime, retry, retryDelay }),
    )
  })

  // Polling: refetch on an interval, independent of staleTime (staleTime: 0
  // forces the fetch). The function form is reactive — reading state() makes
  // the effect re-run when data changes, so returning false stops polling.
  track((onCleanup) => {
    const { queryKey, queryFn, retry, retryDelay, refetchInterval, enabled } =
      defaultedOptions()

    if (enabled === false) return

    const interval =
      typeof refetchInterval === 'function'
        ? refetchInterval({ state: query().state() })
        : refetchInterval

    if (!interval) return

    const id = setInterval(() => {
      client.fetchQuery(queryKey, queryFn, {
        staleTime: 0,
        retry,
        retryDelay,
      })
    }, interval)

    onCleanup(() => clearInterval(id))
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
        const { queryKey, queryFn, retry, retryDelay } =
          untracked(defaultedOptions)

        client.fetchQuery(queryKey, queryFn, {
          staleTime: 0,
          retry,
          retryDelay,
          cancelRefetch: true,
        })
      },
    },
    destroy: () => refs.forEach((ref) => ref.destroy()),
  }
}
