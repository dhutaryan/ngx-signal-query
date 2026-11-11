import type { QueryOptions } from './types'

/**
 * Identity helper that defines a typed, reusable set of {@link QueryOptions}.
 *
 * Returns the options unchanged at runtime, but anchors type inference so the
 * same definition can be handed to {@link injectQuery} and
 * {@link injectQueries} without re-declaring generics, and its `queryKey`
 * reused wherever the key is needed, such as
 * {@link QueryClient.invalidateQueries}. A key carries no type, though:
 * {@link QueryClient.getQueryData} and {@link QueryClient.setQueryData} still
 * take the data type as a generic. Keeping query definitions in a service
 * (rather than inline) makes them easy to reuse and unit-test.
 *
 * @typeParam TData - Type of the data resolved by `queryFn`.
 * @typeParam TError - Type of the error thrown by `queryFn`.
 * @param options - The {@link QueryOptions} to define.
 * @returns The same `options`, typed.
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
export function queryOptions<TData, TError = Error>(
  options: QueryOptions<TData, TError>,
): QueryOptions<TData, TError> {
  return options
}
