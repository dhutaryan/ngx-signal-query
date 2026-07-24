/**
 * Placeholder function that keeps the previous query's data visible while the
 * next one loads — pass as `placeholderData` to avoid flicker when the query
 * key changes (e.g. pagination, search).
 *
 * While the placeholder is shown, `status` reads `'success'` and
 * `isPlaceholderData()` is `true`; `isFetching()` stays `true` so the UI can
 * indicate the data is stale.
 *
 * @example
 * ```ts
 * readonly todos = injectQuery(() => ({
 *   queryKey: ['todos', this.page()],
 *   queryFn: () => this.http.get<Todo[]>(`/api/todos?page=${this.page()}`),
 *   placeholderData: keepPreviousData,
 * }))
 * ```
 */
export function keepPreviousData<TData>(
  previousData: TData | undefined,
): TData | undefined {
  return previousData
}
