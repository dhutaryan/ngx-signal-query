import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  Injector,
} from '@angular/core'

import { createQueryObserver } from './query-observer'
import type { QueryOptions, QueryResult } from './types'

/**
 * Runs a cached, reactive query and exposes its state as signals.
 *
 * The query is keyed by `queryKey`: calls with the same key share a single
 * cache entry and in-flight request (deduplication). `optionsFn` is read in a
 * reactive context, so when a value it depends on changes (e.g. a route or
 * input signal in the key), the query automatically switches to the new key
 * and fetches. `optionsFn` isn't called before the query is first needed (its
 * first effect run or the first read of a result signal), so it can read
 * inputs, `input.required` included, and fields declared after the query. The
 * query is bound to the current injection context and cleans up its cache
 * observer when that context is destroyed.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @param optionsFn - Factory returning the {@link QueryOptions}. Re-evaluated
 *   reactively: a new `queryKey` switches to that query and fetches it, and
 *   turning `enabled` on starts the fetch. Re-evaluating with the same key
 *   does not refetch, so every value `queryFn` reads belongs in the key.
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
  const { result, destroy } = createQueryObserver(optionsFn, injector)

  // The observation lives as long as the owning context (component or
  // injector): tear it down with it.
  injector.get(DestroyRef).onDestroy(destroy)

  return result
}
