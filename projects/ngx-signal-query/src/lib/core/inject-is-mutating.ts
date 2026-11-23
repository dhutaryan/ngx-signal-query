import {
  type Injector,
  type Signal,
  assertInInjectionContext,
  computed,
  inject,
} from '@angular/core'

import type { MutationFilters } from './mutation'
import { QueryClient } from './query-client'

/**
 * Returns a signal with the number of mutations currently pending, including
 * those still running their hooks — useful for a global "saving…" indicator.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal<number>` of in-flight mutations.
 *
 * @example
 * ```ts
 * readonly isMutating = injectIsMutating()
 * // <p>{{ isMutating() > 0 ? 'Saving…' : '' }}</p>
 * ```
 */
export function injectIsMutating(options?: {
  injector?: Injector
}): Signal<number>
/**
 * Returns a signal with the number of pending mutations whose key matches
 * the filters, including those still running their hooks: a "Saving…" for
 * one kind of write, or for one item.
 *
 * The filters are a function, called inside the signal's computation, the
 * way {@link injectQuery} calls its options, so they can use a signal or an
 * input. A run is matched by the key its options gave when `mutate()` was
 * called.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param filters - Returns the {@link MutationFilters} to match, without
 *   `status`: only pending runs count.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal<number>` of the matching pending mutations.
 *
 * @example
 * ```ts
 * readonly todo = input.required<Todo>()
 * readonly saving = injectIsMutating(() => ({
 *   mutationKey: ['todos', 'update', this.todo().id],
 * }))
 * // <span>{{ saving() > 0 ? 'Saving…' : '' }}</span>
 * ```
 */
export function injectIsMutating(
  filters?: () => Omit<MutationFilters, 'status'>,
  options?: { injector?: Injector },
): Signal<number>

export function injectIsMutating(
  filtersOrOptions?:
    | (() => Omit<MutationFilters, 'status'>)
    | { injector?: Injector },
  optionsAfterFilters?: { injector?: Injector },
): Signal<number> {
  // The options are an object and the filters a function, so an object
  // first is a call without filters.
  const [filters, options] =
    typeof filtersOrOptions === 'object'
      ? [undefined, filtersOrOptions]
      : [filtersOrOptions, optionsAfterFilters]

  if (!options?.injector) assertInInjectionContext(injectIsMutating)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getMutationCache()

  return computed(
    () => cache.findAll({ ...filters?.(), status: 'pending' }).length,
  )
}
