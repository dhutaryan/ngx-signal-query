import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  Injector,
} from '@angular/core'

import { createInfiniteQueryObserver } from './infinite-query-observer'
import type {
  DefinedInfiniteQueryResult,
  DefinedInitialDataInfiniteOptions,
  InfiniteQueryOptions,
  InfiniteQueryResult,
  QueryKey,
} from './types'

/**
 * Runs a cached, reactive infinite query, a list fetched page by page and
 * kept as one cache entry, and exposes its state as signals.
 *
 * Its data is the pages fetched so far and the param each one was fetched
 * with (see {@link InfiniteData}). The first page is fetched with
 * `initialPageParam`. `fetchNextPage()` adds the page after the last one,
 * with the param `getNextPageParam` gives for it, and `fetchPreviousPage()`
 * the page before the first one, with `getPreviousPageParam`'s;
 * `hasNextPage()` and `hasPreviousPage()` say whether there is one, and
 * `maxPages` caps how many pages the query keeps. While another fetch of the
 * query is in flight, they wait for it and add no page: ask again once
 * `isFetching()` is `false`.
 *
 * A refetch, whatever asks for it (a stale mount, `invalidateQueries()`,
 * `refetch()`, polling, window focus or reconnect), fetches the pages again
 * in order: the first with its own param, each next one with the param
 * `getNextPageParam` gives for the page just fetched, as many pages as the
 * query holds, so the list stays as long. A retry goes on from the page that
 * failed.
 *
 * Otherwise it works as {@link injectQuery} does: the same key shares one
 * cache entry and one fetch, `optionsFn` is reactive and read lazily, and the
 * query is bound to the current injection context.
 *
 * With an `initialData` that always seeds the list, the pages as a value
 * whose type leaves `undefined` out or a function whose return type does, the
 * result is a
 * {@link DefinedInfiniteQueryResult}: its `data()` holds the pages from the
 * first read, with no `undefined` in its type.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 * @param optionsFn - Factory returning the {@link InfiniteQueryOptions}.
 *   Re-evaluated reactively, as `injectQuery`'s is.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link DefinedInfiniteQueryResult}: the signals of an
 *   {@link InfiniteQueryResult}, with `data()` holding the pages from the
 *   first read, those of the pages around them, and `fetchNextPage()` /
 *   `fetchPreviousPage()`.
 *
 * @example
 * ```ts
 * readonly todos = injectInfiniteQuery(() => ({
 *   queryKey: ['todos', 'infinite'],
 *   queryFn: ({ pageParam }) =>
 *     this.http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
 *   initialPageParam: 0,
 *   getNextPageParam: (lastPage) => lastPage.nextCursor,
 * }))
 *
 * // The todos of every loaded page, in order.
 * readonly items = computed(
 *   () => this.todos.data()?.pages.flatMap((page) => page.todos) ?? [],
 * )
 *
 * // <button
 * //   (click)="todos.fetchNextPage()"
 * //   [disabled]="!todos.hasNextPage() || todos.isFetching()"
 * // >
 * //   {{ todos.isFetchingNextPage() ? 'Loading more…' : 'Load more' }}
 * // </button>
 * ```
 */
export function injectInfiniteQuery<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  optionsFn: () => DefinedInitialDataInfiniteOptions<
    TPage,
    TError,
    TQueryKey,
    TPageParam
  >,
  options?: { injector?: Injector },
): DefinedInfiniteQueryResult<TPage, TError, TPageParam>

// Any other options, whose data() may be undefined. It repeats the JSDoc
// above, with its own @returns: an editor's parameter hints show the JSDoc of
// the signature they pick, and of no other. TypeScript types the callbacks in
// the options while it tries the signature above, so the two signatures have
// to type them alike.
/**
 * Runs a cached, reactive infinite query, a list fetched page by page and
 * kept as one cache entry, and exposes its state as signals.
 *
 * Its data is the pages fetched so far and the param each one was fetched
 * with (see {@link InfiniteData}). The first page is fetched with
 * `initialPageParam`. `fetchNextPage()` adds the page after the last one,
 * with the param `getNextPageParam` gives for it, and `fetchPreviousPage()`
 * the page before the first one, with `getPreviousPageParam`'s;
 * `hasNextPage()` and `hasPreviousPage()` say whether there is one, and
 * `maxPages` caps how many pages the query keeps. While another fetch of the
 * query is in flight, they wait for it and add no page: ask again once
 * `isFetching()` is `false`.
 *
 * A refetch, whatever asks for it (a stale mount, `invalidateQueries()`,
 * `refetch()`, polling, window focus or reconnect), fetches the pages again
 * in order: the first with its own param, each next one with the param
 * `getNextPageParam` gives for the page just fetched, as many pages as the
 * query holds, so the list stays as long. A retry goes on from the page that
 * failed.
 *
 * Otherwise it works as {@link injectQuery} does: the same key shares one
 * cache entry and one fetch, `optionsFn` is reactive and read lazily, and the
 * query is bound to the current injection context.
 *
 * With an `initialData` that always seeds the list, the pages as a value
 * whose type leaves `undefined` out or a function whose return type does, the
 * result is a
 * {@link DefinedInfiniteQueryResult}: its `data()` holds the pages from the
 * first read, with no `undefined` in its type.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 * @param optionsFn - Factory returning the {@link InfiniteQueryOptions}.
 *   Re-evaluated reactively, as `injectQuery`'s is.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns An {@link InfiniteQueryResult}: a query's signals, whose `data`
 *   holds the pages, those of the pages around them, and
 *   `fetchNextPage()` / `fetchPreviousPage()`.
 *
 * @example
 * ```ts
 * readonly todos = injectInfiniteQuery(() => ({
 *   queryKey: ['todos', 'infinite'],
 *   queryFn: ({ pageParam }) =>
 *     this.http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
 *   initialPageParam: 0,
 *   getNextPageParam: (lastPage) => lastPage.nextCursor,
 * }))
 *
 * // The todos of every loaded page, in order.
 * readonly items = computed(
 *   () => this.todos.data()?.pages.flatMap((page) => page.todos) ?? [],
 * )
 *
 * // <button
 * //   (click)="todos.fetchNextPage()"
 * //   [disabled]="!todos.hasNextPage() || todos.isFetching()"
 * // >
 * //   {{ todos.isFetchingNextPage() ? 'Loading more…' : 'Load more' }}
 * // </button>
 * ```
 */
export function injectInfiniteQuery<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  optionsFn: () => InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam>,
  options?: { injector?: Injector },
): InfiniteQueryResult<TPage, TError, TPageParam>

// One implementation for both signatures: they differ only in their types.
export function injectInfiniteQuery<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  optionsFn: () => InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam>,
  options?: { injector?: Injector },
): InfiniteQueryResult<TPage, TError, TPageParam> {
  if (!options?.injector) assertInInjectionContext(injectInfiniteQuery)

  const injector = options?.injector ?? inject(Injector)
  const { result, destroy } = createInfiniteQueryObserver(optionsFn, injector)

  // The observation lives as long as the owning context: tear it down with
  // it.
  injector.get(DestroyRef).onDestroy(destroy)

  return result
}
