import type {
  DataTag,
  DefinedInitialDataInfiniteOptions,
  InfiniteData,
  InfiniteQueryOptions,
  QueryKey,
} from './types'

/**
 * Identity helper that defines a typed, reusable set of
 * {@link InfiniteQueryOptions}, as {@link queryOptions} does for a query.
 *
 * Returns the options unchanged at runtime, but anchors type inference: the
 * page type comes from `queryFn`, the param type from `initialPageParam`,
 * so the same definition can be handed to {@link injectInfiniteQuery} and
 * {@link QueryClient.infiniteQuery} without re-declaring generics, and its
 * `queryKey` reused wherever the key is needed, such as
 * {@link QueryClient.invalidateQueries}. The key carries the list's type,
 * {@link InfiniteData} of the page and param types (see {@link DataTag}), so
 * {@link QueryClient.getQueryData} and {@link QueryClient.setQueryData} read
 * and write the list with no generic to write. Options whose `initialData`
 * always seeds the list keep that in their type (see
 * {@link DefinedInitialDataInfiniteOptions}), so a list made of the definition
 * has `data()` with no `undefined` in its type.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 * @param options - The {@link InfiniteQueryOptions} to define.
 * @returns The same `options`, typed, with a key that carries the list's
 *   type: a {@link DefinedInitialDataInfiniteOptions}, since `initialData`
 *   always seeds the list.
 *
 * @example
 * ```ts
 * // In a service:
 * todos() {
 *   return infiniteQueryOptions({
 *     queryKey: ['todos', 'infinite'],
 *     queryFn: ({ pageParam }) =>
 *       this.http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
 *     initialPageParam: 0,
 *     getNextPageParam: (lastPage) => lastPage.nextCursor,
 *   })
 * }
 *
 * // In a component:
 * readonly todos = injectInfiniteQuery(() => this.#queries.todos())
 * ```
 */
export function infiniteQueryOptions<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: DefinedInitialDataInfiniteOptions<
    TPage,
    TError,
    TQueryKey,
    TPageParam
  >,
): DefinedInitialDataInfiniteOptions<
  TPage,
  TError,
  DataTag<TQueryKey, InfiniteData<TPage, TPageParam>>,
  TPageParam
>

// Any other options. It repeats the JSDoc above, with its own @returns: an
// editor's parameter hints show the JSDoc of the signature they pick, and of
// no other. TypeScript types the callbacks in the options while it tries the
// signature above, so the two signatures have to type them alike.
/**
 * Identity helper that defines a typed, reusable set of
 * {@link InfiniteQueryOptions}, as {@link queryOptions} does for a query.
 *
 * Returns the options unchanged at runtime, but anchors type inference: the
 * page type comes from `queryFn`, the param type from `initialPageParam`,
 * so the same definition can be handed to {@link injectInfiniteQuery} and
 * {@link QueryClient.infiniteQuery} without re-declaring generics, and its
 * `queryKey` reused wherever the key is needed, such as
 * {@link QueryClient.invalidateQueries}. The key carries the list's type,
 * {@link InfiniteData} of the page and param types (see {@link DataTag}), so
 * {@link QueryClient.getQueryData} and {@link QueryClient.setQueryData} read
 * and write the list with no generic to write. Options whose `initialData`
 * always seeds the list keep that in their type (see
 * {@link DefinedInitialDataInfiniteOptions}), so a list made of the definition
 * has `data()` with no `undefined` in its type.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 * @param options - The {@link InfiniteQueryOptions} to define.
 * @returns The same `options`, typed, with a key that carries the list's
 *   type.
 *
 * @example
 * ```ts
 * // In a service:
 * todos() {
 *   return infiniteQueryOptions({
 *     queryKey: ['todos', 'infinite'],
 *     queryFn: ({ pageParam }) =>
 *       this.http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
 *     initialPageParam: 0,
 *     getNextPageParam: (lastPage) => lastPage.nextCursor,
 *   })
 * }
 *
 * // In a component:
 * readonly todos = injectInfiniteQuery(() => this.#queries.todos())
 * ```
 */
export function infiniteQueryOptions<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam>,
): InfiniteQueryOptions<
  TPage,
  TError,
  DataTag<TQueryKey, InfiniteData<TPage, TPageParam>>,
  TPageParam
>

// One implementation for both signatures: they differ only in their types.
export function infiniteQueryOptions<
  TPage,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam>,
): InfiniteQueryOptions<
  TPage,
  TError,
  DataTag<TQueryKey, InfiniteData<TPage, TPageParam>>,
  TPageParam
> {
  // Only the type changes: the key now carries the list's type.
  return options as InfiniteQueryOptions<
    TPage,
    TError,
    DataTag<TQueryKey, InfiniteData<TPage, TPageParam>>,
    TPageParam
  >
}
