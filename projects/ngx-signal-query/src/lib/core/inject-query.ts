import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  Injector,
} from '@angular/core'

import { fetchArgsOf } from './query'
import { createQueryObserver } from './query-observer'
import type {
  DefinedInitialDataOptions,
  DefinedQueryResult,
  QueryKey,
  QueryOptions,
  QueryResult,
} from './types'

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
 * With an `initialData` that always seeds the query, a value whose type
 * leaves `undefined` out or a function whose return type does, the query has
 * data from its first read, and the result is a {@link DefinedQueryResult}:
 * its `data()` has the type `TData` rather than `TData | undefined`.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @param optionsFn - Factory returning the {@link QueryOptions}. Re-evaluated
 *   reactively: a new `queryKey` switches to that query and fetches it, and
 *   turning `enabled` on starts the fetch. Re-evaluating with the same key
 *   does not refetch, so every value `queryFn` reads belongs in the key. A
 *   key that `removeQueries()` or `clear()` dropped is the exception:
 *   re-evaluating puts it back and fetches it as it would a new key.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link DefinedQueryResult}: the signals of a
 *   {@link QueryResult} (`data`, `status`, `error`, `isLoading`, `isPending`,
 *   …), with `data()` of the type `TData`, plus a `refetch()` that forces a
 *   fresh fetch.
 *
 * @example
 * ```ts
 * readonly id = input.required<number>()
 *
 * // Refetches automatically whenever `id()` changes.
 * readonly todo = injectQuery(() => ({
 *   queryKey: ['todo', this.id()],
 *   queryFn: () => this.http.get<Todo>(`/api/todos/${this.id()}`),
 * }))
 *
 * // <p>{{ todo.isPending() ? 'Loading…' : todo.data()?.title }}</p>
 * ```
 */
export function injectQuery<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  optionsFn: () => DefinedInitialDataOptions<TData, TError, TQueryKey>,
  options?: { injector?: Injector },
): DefinedQueryResult<TData, TError>

// Any other options, whose data() may be undefined. It repeats the JSDoc
// above, with its own @returns: an editor's parameter hints show the JSDoc of
// the signature they pick, and of no other. TypeScript types the callbacks in
// the options while it tries the signature above, so the two signatures have
// to type them alike.
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
 * With an `initialData` that always seeds the query, a value whose type
 * leaves `undefined` out or a function whose return type does, the query has
 * data from its first read, and the result is a {@link DefinedQueryResult}:
 * its `data()` has the type `TData` rather than `TData | undefined`.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @param optionsFn - Factory returning the {@link QueryOptions}. Re-evaluated
 *   reactively: a new `queryKey` switches to that query and fetches it, and
 *   turning `enabled` on starts the fetch. Re-evaluating with the same key
 *   does not refetch, so every value `queryFn` reads belongs in the key. A
 *   key that `removeQueries()` or `clear()` dropped is the exception:
 *   re-evaluating puts it back and fetches it as it would a new key.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link QueryResult} of signals (`data`, `status`, `error`,
 *   `isLoading`, `isPending`, …) plus a `refetch()` that forces a fresh fetch.
 *
 * @example
 * ```ts
 * readonly id = input.required<number>()
 *
 * // Refetches automatically whenever `id()` changes.
 * readonly todo = injectQuery(() => ({
 *   queryKey: ['todo', this.id()],
 *   queryFn: () => this.http.get<Todo>(`/api/todos/${this.id()}`),
 * }))
 *
 * // <p>{{ todo.isPending() ? 'Loading…' : todo.data()?.title }}</p>
 * ```
 */
export function injectQuery<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  optionsFn: () => QueryOptions<TData, TError, TQueryKey>,
  options?: { injector?: Injector },
): QueryResult<TData, TError>

// One implementation for both signatures: they differ only in their types.
export function injectQuery<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  optionsFn: () => QueryOptions<TData, TError, TQueryKey>,
  options?: { injector?: Injector },
): QueryResult<TData, TError> {
  if (!options?.injector) assertInInjectionContext(injectQuery)

  const injector = options?.injector ?? inject(Injector)
  const { result, destroy } = createQueryObserver<TData, TError>(
    optionsFn,
    injector,
    fetchArgsOf,
  )

  // The observation lives as long as the owning context (component or
  // injector): tear it down with it.
  injector.get(DestroyRef).onDestroy(destroy)

  return result
}
