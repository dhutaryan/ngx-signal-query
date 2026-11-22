import type {
  DataTag,
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
 * and write the list with no generic to write.
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
 * @Injectable({ providedIn: 'root' })
 * class TodoQueries {
 *   private readonly http = inject(HttpClient)
 *
 *   todos() {
 *     return infiniteQueryOptions({
 *       queryKey: ['todos', 'infinite'],
 *       queryFn: ({ pageParam }) =>
 *         this.http.get<TodoPage>(`/api/todos?cursor=${pageParam}`),
 *       initialPageParam: 0,
 *       getNextPageParam: (lastPage) => lastPage.nextCursor,
 *     })
 *   }
 * }
 *
 * // In a component:
 * // private readonly queries = inject(TodoQueries)
 * // readonly todos = injectInfiniteQuery(() => this.queries.todos())
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
> {
  // Only the type changes: the key now carries the list's type.
  return options as InfiniteQueryOptions<
    TPage,
    TError,
    DataTag<TQueryKey, InfiniteData<TPage, TPageParam>>,
    TPageParam
  >
}
