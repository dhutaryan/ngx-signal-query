import { type Injector, assertInInjectionContext, inject } from '@angular/core'

import { QueryClient } from './query-client'

/**
 * Returns the {@link QueryClient} the injection context (or the given
 * `injector`) sees, for imperative cache access: the app's, unless a route or
 * another environment injector provides one of its own.
 *
 * Use it to read or write cached data (`getQueryData`, `setQueryData`) and to
 * invalidate, cancel, or remove queries — typically from mutation hooks or
 * event handlers. Requires {@link provideQueryClient} to be registered.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param options - Optional `injector` to use outside an injection context.
 * @returns That {@link QueryClient}.
 *
 * @example
 * ```ts
 * const client = injectQueryClient()
 * client.setQueryData<Todo[]>(
 *   ['todos'],
 *   (todos) => todos && [...todos, newTodo],
 * )
 * client.invalidateQueries({ queryKey: ['todos'] })
 * ```
 */
export function injectQueryClient(options?: {
  injector?: Injector
}): QueryClient {
  if (!options?.injector) assertInInjectionContext(injectQueryClient)

  return options?.injector?.get(QueryClient) ?? inject(QueryClient)
}
