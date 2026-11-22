import type {
  DataTag,
  DefinedInitialDataOptions,
  QueryKey,
  QueryOptions,
} from './types'

/**
 * Identity helper that defines a typed, reusable set of {@link QueryOptions}.
 *
 * Returns the options unchanged at runtime, but anchors type inference so the
 * same definition can be handed to {@link injectQuery}, {@link injectQueries}
 * and {@link QueryClient.query} without re-declaring generics, and its
 * `queryKey` reused wherever the key is needed, such as
 * {@link QueryClient.invalidateQueries}. The key carries the data type (see
 * {@link DataTag}): {@link QueryClient.getQueryData} and
 * {@link QueryClient.setQueryData} take the type from it, with no generic to
 * write. Options whose `initialData` always seeds the query keep that in their
 * type (see {@link DefinedInitialDataOptions}), so a query made of the
 * definition has `data()` of the type `TData`. Keeping query definitions in a
 * service (rather than inline) makes them easy to reuse and unit-test.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @param options - The {@link QueryOptions} to define.
 * @returns The same `options`, typed, with a key that carries the data type:
 *   a {@link DefinedInitialDataOptions}, since `initialData` always seeds the
 *   query.
 *
 * @example
 * ```ts
 * @Injectable({ providedIn: 'root' })
 * class TodoQueries {
 *   private readonly http = inject(HttpClient)
 *
 *   todos() {
 *     return queryOptions({
 *       queryKey: ['todos'],
 *       queryFn: () => this.http.get<Todo[]>('/api/todos'),
 *     })
 *   }
 * }
 *
 * // In a component:
 * // private readonly queries = inject(TodoQueries)
 * // readonly todos = injectQuery(() => this.queries.todos())
 * ```
 */
export function queryOptions<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: DefinedInitialDataOptions<TData, TError, TQueryKey>,
): DefinedInitialDataOptions<TData, TError, DataTag<TQueryKey, TData>>

// Any other options. It repeats the JSDoc above, with its own @returns: an
// editor's parameter hints show the JSDoc of the signature they pick, and of
// no other. TypeScript types the callbacks in the options while it tries the
// signature above, so the two signatures have to type them alike.
/**
 * Identity helper that defines a typed, reusable set of {@link QueryOptions}.
 *
 * Returns the options unchanged at runtime, but anchors type inference so the
 * same definition can be handed to {@link injectQuery}, {@link injectQueries}
 * and {@link QueryClient.query} without re-declaring generics, and its
 * `queryKey` reused wherever the key is needed, such as
 * {@link QueryClient.invalidateQueries}. The key carries the data type (see
 * {@link DataTag}): {@link QueryClient.getQueryData} and
 * {@link QueryClient.setQueryData} take the type from it, with no generic to
 * write. Options whose `initialData` always seeds the query keep that in their
 * type (see {@link DefinedInitialDataOptions}), so a query made of the
 * definition has `data()` of the type `TData`. Keeping query definitions in a
 * service (rather than inline) makes them easy to reuse and unit-test.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @typeParam TQueryKey - Type of `queryKey`, which `queryFn` gets the key
 *   with.
 * @param options - The {@link QueryOptions} to define.
 * @returns The same `options`, typed, with a key that carries the data type.
 *
 * @example
 * ```ts
 * @Injectable({ providedIn: 'root' })
 * class TodoQueries {
 *   private readonly http = inject(HttpClient)
 *
 *   todos() {
 *     return queryOptions({
 *       queryKey: ['todos'],
 *       queryFn: () => this.http.get<Todo[]>('/api/todos'),
 *     })
 *   }
 * }
 *
 * // In a component:
 * // private readonly queries = inject(TodoQueries)
 * // readonly todos = injectQuery(() => this.queries.todos())
 * ```
 */
export function queryOptions<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: QueryOptions<TData, TError, TQueryKey>,
): QueryOptions<TData, TError, DataTag<TQueryKey, TData>>

// One implementation for both signatures: they differ only in their types.
export function queryOptions<
  TData,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: QueryOptions<TData, TError, TQueryKey>,
): QueryOptions<TData, TError, DataTag<TQueryKey, TData>> {
  // Only the type changes: the key now carries the data type.
  return options as QueryOptions<TData, TError, DataTag<TQueryKey, TData>>
}
