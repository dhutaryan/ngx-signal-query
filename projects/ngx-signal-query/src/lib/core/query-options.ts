import { QueryOptions } from './types'

/**
 * Identity helper that defines a typed, reusable set of {@link QueryOptions}.
 *
 * Returns the options unchanged at runtime, but anchors type inference so the
 * same definition can be shared across {@link injectQuery},
 * {@link QueryClient.setQueryData}, and friends without re-declaring generics.
 * Keeping query definitions in a service (rather than inline) makes them easy
 * to reuse and unit-test.
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
 * // const todos = injectQuery(() => inject(TodoQueries).todos())
 * ```
 */
export function queryOptions<TData, TError = Error>(
  options: QueryOptions<TData, TError>,
): QueryOptions<TData, TError> {
  return options
}
