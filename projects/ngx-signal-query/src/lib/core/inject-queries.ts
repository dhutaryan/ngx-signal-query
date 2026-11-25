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

import { fetchArgsOf } from './query'
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

// A query kept alive by injectQueries: its observer, and the signal that
// feeds the observer's effects their options. The effect of injectQueries
// writes that signal in place for as long as the key stays in the list.
// Whatever is fetched for the query goes by what optionsFn gives right now
// instead (see optionsByHash).
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
 * their observer. Whatever is fetched for the queries goes by what
 * `optionsFn` gives right now, even before change detection updates the
 * results: a dropped key isn't fetched for the list any more. As with
 * `injectQuery`, `optionsFn` isn't called before the results are first
 * needed, so it can read inputs, `input.required` included, and fields
 * declared after the call. Aggregate across the results with `computed`.
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
 * readonly todoIds = input.required<number[]>()
 *
 * readonly todos = injectQueries(() => ({
 *   queries: this.todoIds().map((id) => this.#queries.detail(id)),
 * }))
 *
 * readonly isPending = computed(() =>
 *   this.todos().some((todo) => todo.isPending()),
 * )
 * ```
 */
export function injectQueries<TData, TError = Error>(
  optionsFn: () => InjectQueriesOptions<TData, TError>,
  options?: { injector?: Injector },
): Signal<Array<QueryResult<TData, TError>>> {
  if (!options?.injector) assertInInjectionContext(injectQueries)

  const injector = options?.injector ?? inject(Injector)

  let entries: Array<Entry<TData, TError>> = []
  let results: Array<QueryResult<TData, TError>> = []
  let destroyed = false

  // The queries that optionsFn gives, from one run of it each time what it
  // reads changes. The effect below syncs the entries from them, a read
  // before the effect's first run does too, and optionsByHash finds each
  // entry's options in them: since all of them see the same run, an entry
  // always finds its own key, even when optionsFn reads values that aren't
  // signals or puts the current time in a key. Every run counts as a change,
  // also one that gives back the same array changed in place: the entries
  // are synced after each run, like they would be if the effect ran
  // optionsFn itself.
  const currentQueries = computed(() => optionsFn().queries, {
    equal: () => false,
  })

  // currentQueries by key hash, in list order for a key listed more than
  // once: a sync run now would hand each entry the options found here at its
  // hash and rank (see sync). Every fetch made for an entry goes by them
  // already, not by the options that the effect below handed it last: until
  // change detection runs that effect, a queryFn that reads a signal when it
  // runs, like `() => api(this.id())` does, asks for what the signal holds
  // now. An entry that finds nothing at its hash and rank has left the list:
  // its observer is unlisted (see createQueryObserver).
  const optionsByHash = computed(() => {
    const byHash = new Map<string, Array<QueryOptions<TData, TError>>>()

    for (const queryOptions of currentQueries()) {
      const hash = hashKey(queryOptions.queryKey)
      const list = byHash.get(hash) ?? []

      list.push(queryOptions)
      byHash.set(hash, list)
    }

    return byHash
  })

  // Reconciles the entries with a new list, matching by key hash the way
  // TanStack's QueriesObserver does: a matching entry is reused and handed the
  // new options, an unmatched query gets a fresh observer, and whatever is
  // left over is destroyed. Duplicate keys are paired up one-to-one in order,
  // so an entry keeps its rank among the entries of its key while it lives.
  const sync = (
    queries: Array<QueryOptions<TData, TError>>,
  ): Array<QueryResult<TData, TError>> => {
    const pool = new Map<string, Array<Entry<TData, TError>>>()
    // How many queries of each key the list has had so far.
    const seen = new Map<string, number>()

    for (const entry of entries) {
      const list = pool.get(entry.hash) ?? []

      list.push(entry)
      pool.set(entry.hash, list)
    }

    const next = queries.map((queryOptions) => {
      const hash = hashKey(queryOptions.queryKey)
      // Which of the list's queries with this key it is, counting from 0.
      const rank = seen.get(hash) ?? 0
      const match = pool.get(hash)?.shift()

      seen.set(hash, rank + 1)

      if (match) {
        match.options.set(queryOptions)

        return match
      }

      const optionsSignal = signal(queryOptions)

      return {
        hash,
        options: optionsSignal,
        observer: createQueryObserver<TData, TError>(
          () => optionsSignal(),
          injector,
          fetchArgsOf,
          () => optionsByHash().get(hash)?.[rank] ?? null,
        ),
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

    if (changed) results = entries.map((entry) => entry.observer.result)

    return results
  }

  // The results of the effect's latest sync; unset until its first run.
  const synced = signal<Array<QueryResult<TData, TError>> | undefined>(
    undefined,
  )

  effect(
    () => {
      const queries = currentQueries()

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
      synced() ?? (destroyed ? [] : untracked(() => sync(currentQueries()))),
  )
}
