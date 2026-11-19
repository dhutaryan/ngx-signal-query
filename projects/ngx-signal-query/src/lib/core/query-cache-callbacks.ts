import { inject } from '@angular/core'

import { injectHostApp } from './host-app'
import { QUERY_CACHE_CONFIG } from './injection-tokens'
import type { QuerySnapshot } from './types'
import { isPromiseLike } from './utils'

/**
 * The app's callbacks for every query in the cache (see withQueryCache), as
 * a query calls them: success() once a fetch of it lands, error() once one
 * fails for good. The callbacks get the query as the fetch left it. Neither
 * function throws.
 *
 * @internal
 */
export type QueryCacheCallbacks = {
  /** The fetch landed with `data`: onSuccess, then onSettled. */
  success: (query: QuerySnapshot, data: unknown) => void
  /**
   * The fetch failed for good, after its retries: onError, then onSettled
   * with the data the query keeps.
   */
  error: (query: QuerySnapshot, error: unknown) => void
}

/**
 * The app's callbacks for every query in the cache, as withQueryCache sets
 * them. Must run in the injection context of the injector that provides the
 * client.
 *
 * @internal
 */
export function injectQueryCacheCallbacks(): QueryCacheCallbacks {
  const config = inject(QUERY_CACHE_CONFIG, { optional: true }) ?? {}
  const app = injectHostApp()

  // Each runs in the app's injection context, and not at all once the app is
  // gone (see HostApp), as a method of the config, as TanStack calls them: a
  // config whose callbacks read `this`, a class instance say, keeps it. One
  // that the app doesn't set is undefined.
  const onSuccess = app.inContext(config.onSuccess?.bind(config))
  const onError = app.inContext(config.onError?.bind(config))
  const onSettled = app.inContext(config.onSettled?.bind(config))

  // Calls a callback and doesn't wait for it. What it throws, or a promise it
  // returns that rejects, goes to the app's ErrorHandler, so the next
  // callback still runs.
  const notify = (call: () => unknown): void => {
    try {
      const result = call()

      if (isPromiseLike(result)) result.then(undefined, app.reportError)
    } catch (error) {
      app.reportError(error)
    }
  }

  return {
    success: (query, data) => {
      notify(() => onSuccess?.(data, query))
      notify(() => onSettled?.(data, null, query))
    },
    error: (query, error) => {
      notify(() => onError?.(error, query))
      notify(() => onSettled?.(query.state.data, error, query))
    },
  }
}
