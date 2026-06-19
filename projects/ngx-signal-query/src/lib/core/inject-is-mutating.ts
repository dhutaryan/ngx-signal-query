import {
  assertInInjectionContext,
  computed,
  inject,
  Injector,
  Signal,
} from '@angular/core'

import { QueryClient } from './query-client'

/**
 * Returns a signal with the number of mutations currently pending — useful for
 * a global "saving…" indicator.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A `Signal<number>` of in-flight mutations.
 *
 * @example
 * ```ts
 * readonly isMutating = injectIsMutating()
 * // <p *ngIf="isMutating() > 0">Saving…</p>
 * ```
 */
export function injectIsMutating(options?: {
  injector?: Injector
}): Signal<number> {
  if (!options?.injector) assertInInjectionContext(injectIsMutating)

  const client = options?.injector?.get(QueryClient) ?? inject(QueryClient)
  const cache = client.getMutationCache()

  return computed(() => cache.findAll({ status: 'pending' }).length)
}
