import type { InfiniteQueryOptions, QueryKey } from './types'

/**
 * Identity helper that defines a typed, reusable set of
 * {@link InfiniteQueryOptions}, as {@link queryOptions} does for a query.
 *
 * Returns the options unchanged at runtime, but anchors type inference: the
 * page type comes from `queryFn`, the param type from `initialPageParam`,
 * so the same definition can be handed to {@link injectInfiniteQuery}
 * without re-declaring generics, and its `queryKey` reused wherever the key
 * is needed, such as {@link QueryClient.invalidateQueries}.
 *
 * @typeParam TPage - Type of one page, as `queryFn` resolves it.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @typeParam TPageParam - Type of the param each page is fetched with.
 * @param options - The {@link InfiniteQueryOptions} to define.
 * @returns The same `options`, typed.
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
): InfiniteQueryOptions<TPage, TError, TQueryKey, TPageParam> {
  return options
}
