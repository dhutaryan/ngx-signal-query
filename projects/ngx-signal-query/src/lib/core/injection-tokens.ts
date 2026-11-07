import { InjectionToken } from '@angular/core'

import type { DefaultOptions } from './types'

/** @internal */
export interface QueryClientConfig {
  defaultOptions?: DefaultOptions
}

/** @internal */
export const QUERY_CLIENT_CONFIG = new InjectionToken<QueryClientConfig>(
  'QUERY_CLIENT_CONFIG',
)

/**
 * Set by {@link withHydration}: the client hands its cache from the server
 * render over to the browser.
 *
 * @internal
 */
export const QUERY_CLIENT_HYDRATION = new InjectionToken<boolean>(
  'QUERY_CLIENT_HYDRATION',
)
