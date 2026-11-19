import { inject } from '@angular/core'

import type { MutationCacheConfig } from '../features/with-mutation-cache'
import { injectHostApp } from './host-app'
import { MUTATION_CACHE_CONFIG } from './injection-tokens'

/**
 * The app's callbacks for every mutation (see withMutationCache), as a run
 * calls them: each before the mutation's own hook of the same name, and
 * waited for. What one throws is handled like an error of the mutation's own
 * hook of that name: onMutate's fails the run, any other's goes to the app's
 * ErrorHandler. Each runs in the app's injection context, and not at all
 * once the app is gone (see HostApp).
 *
 * @internal
 */
export type MutationCacheCallbacks = MutationCacheConfig

/**
 * The app's callbacks for every mutation, as withMutationCache sets them.
 * Must run in the injection context of the injector that provides the
 * client.
 *
 * @internal
 */
export function injectMutationCacheCallbacks(): MutationCacheCallbacks {
  const config = inject(MUTATION_CACHE_CONFIG, { optional: true }) ?? {}
  const app = injectHostApp()

  // Each is called as a method of the config, as TanStack calls them: a
  // config whose callbacks read `this`, a class instance say, keeps it.
  return {
    onMutate: app.inContext(config.onMutate?.bind(config)),
    onSuccess: app.inContext(config.onSuccess?.bind(config)),
    onError: app.inContext(config.onError?.bind(config)),
    onSettled: app.inContext(config.onSettled?.bind(config)),
  }
}
