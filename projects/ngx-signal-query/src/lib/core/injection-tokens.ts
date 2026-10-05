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
