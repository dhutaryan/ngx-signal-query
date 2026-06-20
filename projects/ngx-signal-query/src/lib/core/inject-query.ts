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
import type { QueryOptions, QueryResult } from './types'

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
    // it renders immediately as 'success'. updatedAt defaults to 0 → stale →
    // background refetch.
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
          : (initialDataUpdatedAt ?? 0)

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

    effect(() => {
      const key = defaultedOptions().queryKey
      const q = untracked(() => cache.getOrCreate<TData, TError>(key))

      untracked(() => applyInitialData(q))
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

    return {
      data: computed(() => query().state().data),
      status: computed(() => query().state().status),
      error: computed(() => query().state().error as TError | null),
      isFetching: computed(() => query().state().isFetching),
      // First fetch in-flight: fetching with no resolved data yet.
      isLoading: computed(() => {
        const state = query().state()

        return state.isFetching && state.status === 'pending'
      }),
      isPending: computed(() => query().state().status === 'pending'),
      isSuccess: computed(() => query().state().status === 'success'),
      isError: computed(() => query().state().status === 'error'),
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
