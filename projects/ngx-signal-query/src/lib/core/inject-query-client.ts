import { assertInInjectionContext, inject, Injector } from '@angular/core'

import { QueryClient } from './query-client'

/**
 * Returns the application's {@link QueryClient} for imperative cache access.
 *
 * Use it to read or write cached data (`getQueryData`, `setQueryData`) and to
 * invalidate, cancel, or remove queries — typically from mutation hooks or
 * event handlers. Requires {@link provideQueryClient} to be registered.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param options - Optional `injector` to use outside an injection context.
 * @returns The shared {@link QueryClient} instance.
 *
 * @example
 * ```ts
 * const client = injectQueryClient()
 * client.setQueryData<Todo[]>(['todos'], (prev = []) => [...prev, newTodo])
 * client.invalidateQueries({ queryKey: ['todos'] })
 * ```
 */
export function injectQueryClient(options?: {
  injector?: Injector
}): QueryClient {
  if (!options?.injector) assertInInjectionContext(injectQueryClient)

  return options?.injector?.get(QueryClient) ?? inject(QueryClient)
}
