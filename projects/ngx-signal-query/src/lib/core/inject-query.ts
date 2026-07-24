import {
  assertInInjectionContext,
  computed,
  effect,
  inject,
  Injector,
  runInInjectionContext,
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
 * Runs a cached, reactive query and exposes its state as signals.
 *
 * The query is keyed by `queryKey`: calls with the same key share a single
 * cache entry and in-flight request (deduplication). `optionsFn` is read in a
 * reactive context, so when a value it depends on changes (e.g. a route or
 * input signal in the key), the query automatically switches to the new key
 * and fetches. The query is bound to the current injection context and cleans
 * up its cache observer when that context is destroyed.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @param optionsFn - Factory returning the {@link QueryOptions}. Re-evaluated
 *   reactively, so reading signals inside it makes the query re-run on change.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link QueryResult} of signals (`data`, `status`, `error`,
 *   `isLoading`, `isPending`, …) plus a `refetch()` that forces a fresh fetch.
 *
 * @example
 * ```ts
 * @Component({
 *   template: `
 *     @if (todo.isPending()) { <p>Loading…</p> }
 *     @if (todo.data(); as data) { <p>{{ data.title }}</p> }
 *   `,
 * })
 * class TodoComponent {
 *   readonly id = input.required<number>()
 *   private readonly http = inject(HttpClient)
 *
 *   // Refetches automatically whenever `id()` changes.
 *   readonly todo = injectQuery(() => ({
 *     queryKey: ['todo', this.id()],
 *     queryFn: () => this.http.get<Todo>(`/api/todos/${this.id()}`),
 *   }))
 * }
 * ```
 */
export function injectQuery<TData, TError = Error>(
  optionsFn: () => QueryOptions<TData, TError>,
  options?: { injector?: Injector },
): QueryResult<TData, TError> {
  if (!options?.injector) assertInInjectionContext(injectQuery)

  const injector = options?.injector ?? inject(Injector)

  return runInInjectionContext(injector, () => {
    const client = inject(QueryClient)
    const cache = client.getQueryCache()

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

    effect(() => {
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

    effect((cleanup) => {
      const q = query()
      const { gcTime } = untracked(defaultedOptions)

      if (gcTime !== undefined) {
        q.setGcTime(gcTime)
      }

      q.addObserver()
      cleanup(() => q.removeObserver())
    })

    effect(() => {
      const { queryKey, queryFn, staleTime, retry, retryDelay, enabled } =
        defaultedOptions()

      // Track invalidation so invalidateQueries() re-triggers a refetch.
      // When invalidated, cancel any in-flight fetch and start a fresh one
      // (otherwise the stale in-flight result would clear isInvalidated).
      const invalidated = isInvalidated()

      if (enabled === false) return

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
    effect((onCleanup) => {
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
    }
  })
}
