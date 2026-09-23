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
import type { Query } from './query'
import type {
  PlaceholderDataFunction,
  QueryOptions,
  QueryResult,
  QueryStatus,
} from './types'

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

  // getOrCreate mutates the cache (a side effect), so it must not run inside
  // a computed. Resolve the query in a signal: seed it synchronously and
  // update it from an effect whenever the key changes.
  const seed = cache.getOrCreate<TData, TError>(
    untracked(defaultedOptions).queryKey,
  )

  applyInitialData(seed)

  const query = signal(seed)

  // Data of the last query that had any, fed to the placeholderData function
  // on key change (mirrors TanStack's lastQueryWithDefinedData). Captured
  // synchronously before the switch so it can't miss a just-resolved value.
  const lastData = signal<TData | undefined>(undefined)

  track(() => {
    const key = defaultedOptions().queryKey
    const q = untracked(() => cache.getOrCreate<TData, TError>(key))

    untracked(() => {
      const prev = query()

      if (prev !== q && prev.state().data !== undefined) {
        lastData.set(prev.state().data)
      }

      applyInitialData(q)
    })
    query.set(q)
  })

  // Memoized: only emits when the flag itself flips, so ordinary data
  // updates don't wake the fetch effect (no refetch loop).
  const isInvalidated = computed(() => query().state().isInvalidated)

  track((cleanup) => {
    const q = query()
    const { gcTime } = untracked(defaultedOptions)

    if (gcTime !== undefined) {
      q.setGcTime(gcTime)
    }

    q.addObserver()
    cleanup(() => q.removeObserver())
  })

  // Memoized so options re-evaluations that leave the flag alone don't wake
  // the fetch effect.
  const enabled = computed(() => defaultedOptions().enabled !== false)

  // Fetch when the observed query switches (key change), when it becomes
  // enabled, or when it is invalidated — not on every re-evaluation of the
  // options. defaultQueryOptions() builds a fresh object each time, so
  // tracking it whole would refetch stale data whenever any signal read in
  // optionsFn changes, even one unrelated to the key. queryFn, staleTime and
  // the retry policy only parameterise the fetch and are read untracked
  // (TanStack's shouldFetchOptionally).
  track(() => {
    query()

    // Track invalidation so invalidateQueries() re-triggers a refetch.
    // When invalidated, cancel any in-flight fetch and start a fresh one
    // (otherwise the stale in-flight result would clear isInvalidated).
    const invalidated = isInvalidated()

    if (!enabled()) return

    const { queryKey, queryFn, staleTime, retry, retryDelay } =
      untracked(defaultedOptions)

    untracked(() =>
      client.fetchQuery(queryKey, queryFn, {
        staleTime,
        retry,
        retryDelay,
        cancelRefetch: invalidated,
      }),
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
