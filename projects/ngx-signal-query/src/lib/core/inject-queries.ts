import {
  type Signal,
  type WritableSignal,
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core'

import { type QueryObserver, createQueryObserver } from './query-observer'
import type { QueryOptions, QueryResult } from './types'
import { hashKey } from './utils'

/** Options for {@link injectQueries}. */
export interface InjectQueriesOptions<TData, TError = Error> {
  /**
   * One {@link QueryOptions} per query to run. The array may change between
   * evaluations: queries are matched to the previous set by `queryKey`, so a
   * new key starts a query and a missing key ends one.
   */
  queries: Array<QueryOptions<TData, TError>>
}

// A query kept alive by injectQueries: its observer plus the signal feeding it
// options, written in place for as long as the key stays in the list.
interface Entry<TData, TError> {
  hash: string
  options: WritableSignal<QueryOptions<TData, TError>>
  observer: QueryObserver<TData, TError>
}

/**
 * Runs a dynamic number of queries in parallel and exposes their results as a
 * signal holding one {@link QueryResult} per entry of `queries`, in order.
 *
 * Reach for it when the set of queries depends on data — one query per id in
 * a list, say — where {@link injectQuery} can't be called in a loop. Each
 * query behaves exactly like a standalone `injectQuery`: its own cache entry,
 * `staleTime`, retries, error and observer. `optionsFn` is reactive: when the
 * array changes, queries whose `queryKey` is still present are kept (with
 * their options updated), new keys start fetching, and dropped keys release
 * their observer. As with `injectQuery`, `optionsFn` isn't called before the
 * results are first needed, so it can read inputs, `input.required` included,
 * and fields declared after the call. Aggregate across the results with
 * `computed`.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by each `queryFn`.
 * @typeParam TError - Type of the error thrown by each `queryFn`.
 * @param optionsFn - Factory returning the {@link InjectQueriesOptions}.
 *   Re-evaluated reactively, so reading signals inside it re-syncs the set.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A signal of {@link QueryResult}s, one per query. The array identity
 *   changes only when the set of queries changes, not on every data update.
 *
 * @example
 * ```ts
 * class TodoListComponent {
 *   readonly #queries = inject(TodoQueries)
 *
 *   readonly todoIds = input.required<number[]>()
 *
 *   readonly todos = injectQueries(() => ({
 *     queries: this.todoIds().map((id) => this.#queries.detail(id)),
 *   }))
 *
 *   readonly isPending = computed(() =>
 *     this.todos().some((todo) => todo.isPending()),
 *   )
 * }
 * ```
 */
export function injectQueries<TData, TError = Error>(
  optionsFn: () => InjectQueriesOptions<TData, TError>,
  options?: { injector?: Injector },
): Signal<Array<QueryResult<TData, TError>>> {
  if (!options?.injector) assertInInjectionContext(injectQueries)

  const injector = options?.injector ?? inject(Injector)

  let entries: Array<Entry<TData, TError>> = []
  let current: Array<QueryResult<TData, TError>> = []
  let destroyed = false

  // Reconciles the entries with a new list, matching by key hash the way
  // TanStack's QueriesObserver does: a matching entry is reused and handed the
  // new options, an unmatched query gets a fresh observer, and whatever is
  // left over is destroyed. Duplicate keys are paired up one-to-one in order.
  const sync = (
    queries: Array<QueryOptions<TData, TError>>,
  ): Array<QueryResult<TData, TError>> => {
    const pool = new Map<string, Array<Entry<TData, TError>>>()

    for (const entry of entries) {
      const list = pool.get(entry.hash) ?? []

      list.push(entry)
      pool.set(entry.hash, list)
    }

    const next = queries.map((queryOptions) => {
      const hash = hashKey(queryOptions.queryKey)
      const match = pool.get(hash)?.shift()

      if (match) {
        match.options.set(queryOptions)

        return match
      }

      const optionsSignal = signal(queryOptions)

      return {
        hash,
        options: optionsSignal,
        observer: createQueryObserver(() => optionsSignal(), injector),
      }
    })

    for (const leftovers of pool.values()) {
      leftovers.forEach((entry) => entry.observer.destroy())
    }

    // Replace the result array only on a structural change, so a computed
    // over it doesn't recompute when merely the options were refreshed.
    const changed =
      next.length !== entries.length ||
      next.some((entry, index) => entry !== entries[index])

    entries = next

    if (changed) current = entries.map((entry) => entry.observer.result)

    return current
  }

  // The results of the effect's latest sync; unset until its first run.
  const synced = signal<Array<QueryResult<TData, TError>> | undefined>(
    undefined,
  )

  effect(
    () => {
      const { queries } = optionsFn()

      untracked(() => synced.set(sync(queries)))
    },
    { injector },
  )

  injector.get(DestroyRef).onDestroy(() => {
    destroyed = true
    entries.forEach((entry) => entry.observer.destroy())
  })

  // Nothing is synced until first needed: on the first read or the effect's
  // first run, whichever comes first. Syncing calls optionsFn, which may read
  // inputs or fields that don't exist yet while the owner is being
  // constructed. A read before the effect's first run syncs on the spot, so
  // it already sees the queries; once destroyed, it creates nothing.
  return computed(
    () =>
      synced() ?? (destroyed ? [] : untracked(() => sync(optionsFn().queries))),
  )
}
