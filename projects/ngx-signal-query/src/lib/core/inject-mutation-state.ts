import {
  type Injector,
  type Signal,
  assertInInjectionContext,
  computed,
  inject,
} from '@angular/core'

import type {
  Mutation,
  MutationFilters,
  MutationSnapshot,
  MutationState,
} from './mutation'
import { QueryClient } from './query-client'
import { replaceEqualDeep } from './utils'

/**
 * What {@link injectMutationState} lists: the runs that match `filters`,
 * each as its state or, with `select`, as what `select` returns for it.
 *
 * @typeParam TResult - What each run is listed as: its state, or what
 *   `select` returns.
 * @typeParam TSnapshot - The snapshot that `select` takes. Naming the types
 *   of the runs in the type of its parameter, such as
 *   `MutationSnapshot<void, Error, number>`, gives `select` those types;
 *   nothing checks them.
 */
export type MutationStateOptions<
  TResult = Readonly<MutationState<unknown, unknown, unknown, unknown>>,
  TSnapshot extends MutationSnapshot = MutationSnapshot,
> = {
  /**
   * The runs to list, by key and status (see {@link MutationFilters}).
   * Without filters, every run.
   */
  filters?: MutationFilters
  /**
   * What to list for each run instead of its state. It gets the run the way
   * the cache callbacks do (see {@link MutationSnapshot}).
   */
  select?: (mutation: TSnapshot) => TResult
}

/**
 * Returns a signal with the runs that match the filters, whichever component
 * or service started them, in the order they started: each run's state, or
 * what `select` returns for it.
 *
 * It lists what the mutation cache holds, until `clear()` empties it: the
 * runs in flight, hooks included, and the run that each
 * {@link injectMutation} still shows. A
 * mutation shows its latest run until its next `mutate()` or `reset()`, a
 * change of its `mutationKey`, or the destroy of the component or service
 * where it ran. A run that's done and that no mutation shows leaves the list
 * at once, so the list isn't a history of writes: what has to outlive the
 * component that started a write, such as a message about its failure,
 * belongs in the mutation's own hooks, which run either way.
 *
 * The options are a function, called inside the signal's computation, the
 * way {@link injectQuery} calls its options, so the filters and `select` can
 * read a signal or an input. `select` gets each run the way the cache
 * callbacks do (see {@link MutationSnapshot}). The filters can match any
 * mutation, so its types are `unknown` there: say what you expect, with
 * `as` or in the type of its parameter.
 *
 * Like `data()`, the list stays the same array while the same runs are
 * listed with equal items, and an item keeps its reference while it's equal
 * and its run is still listed, even once an earlier run leaves. If the
 * options function or `select` throws, reading the signal throws its error.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TResult - What each run is listed as: its state, or what
 *   `select` returns.
 * @typeParam TSnapshot - The snapshot that `select` takes, when the type of
 *   its parameter names the types of the runs (see
 *   {@link MutationStateOptions}).
 * @param optionsFn - Returns the {@link MutationStateOptions}: the `filters`
 *   that pick the runs, and a `select` for each.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal` with one item per matching run.
 *
 * @example
 * ```ts
 * // The ids of the todos being deleted, wherever the delete started:
 * readonly deletingIds = injectMutationState(() => ({
 *   filters: { mutationKey: ['todos', 'delete'], status: 'pending' },
 *   select: (mutation) => mutation.state.variables as number,
 * }))
 * // <li [class.deleting]="deletingIds().includes(todo.id)">…</li>
 * ```
 */
export function injectMutationState<
  TResult = Readonly<MutationState<unknown, unknown, unknown, unknown>>,
  TSnapshot extends MutationSnapshot = MutationSnapshot,
>(
  optionsFn?: () => MutationStateOptions<TResult, TSnapshot>,
  options?: { injector?: Injector },
): Signal<TResult[]> {
  if (!options?.injector) assertInInjectionContext(injectMutationState)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getMutationCache()
  // The list the signal gave last, and the item that each run had in it.
  let previous: TResult[] = []
  const items = new WeakMap<
    Mutation<unknown, unknown, unknown, unknown>,
    TResult
  >()

  // The options are read in the computed, the way injectQuery reads its
  // own: the list follows the signals they read, and an input has its value
  // by the time the signal is first read. The computed also reads the runs
  // in the cache and the state of each run whose key matches, so the list
  // follows the runs when they start, change state or leave the cache.
  return computed(() => {
    const { filters, select } = optionsFn?.() ?? {}
    const next = cache.findAll(filters).map((run) => {
      // Unchecked casts: the filters can match any mutation, so nothing here
      // can check the types that select's parameter or a type argument give.
      const item = select
        ? select(run.snapshot() as TSnapshot)
        : (run.state() as TResult)
      // Like data(), an item that's equal to the one before keeps its
      // reference. It's compared with the item of the same run, not with the
      // one at the same place in the list: once an earlier run leaves, the
      // runs after it move up.
      const shared = replaceEqualDeep(items.get(run), item)

      items.set(run, shared)

      return shared
    })

    // The same items in the same order give the list before, so whatever
    // reads the signal sees no change.
    const same =
      next.length === previous.length &&
      next.every((item, i) => item === previous[i])

    if (!same) previous = next

    return previous
  })
}
