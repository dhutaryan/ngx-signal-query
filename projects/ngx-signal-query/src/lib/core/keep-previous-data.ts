/**
 * Placeholder function that keeps the previous query's data visible while the
 * next one loads — pass as `placeholderData` to avoid flicker when the query
 * key changes (e.g. pagination, search).
 *
 * While the placeholder is shown, `status` reads `'success'` and
 * `isPlaceholderData()` is `true`: use it to show that the data is the
 * previous key's. `isFetching()` is `true` while the next key's data loads,
 * but not when that key doesn't fetch (`enabled: false`) or its fetch was
 * cancelled.
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
