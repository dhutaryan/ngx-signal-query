/*
 * Public API Surface of ngx-signal-query
 */

export * from './lib/core/query-client'
export * from './lib/core/provider'
export * from './lib/core/inject-query-client'
export * from './lib/core/types'
export * from './lib/core/inject-query'
export * from './lib/core/inject-infinite-query'
export * from './lib/core/inject-queries'
export * from './lib/core/inject-mutation'
export * from './lib/core/inject-is-fetching'
export * from './lib/core/inject-is-mutating'
export * from './lib/core/inject-mutation-state'
export * from './lib/core/query-options'
export * from './lib/core/infinite-query-options'
export * from './lib/core/keep-previous-data'
export * from './lib/core/mutation-options'
export * from './lib/core/cancelled-error'
export type {
  MutateOptions,
  MutationFilters,
  MutationKey,
  MutationOptions,
  MutationResult,
  MutationSnapshot,
  MutationState,
  MutationStatus,
} from './lib/core/mutation'
export { QueryClientFeatureKind } from './lib/features/feature'
export type { QueryClientFeature } from './lib/features/feature'
export { withDefaultOptions } from './lib/features/with-default-options'
export { withHydration } from './lib/features/with-hydration'
export {
  withQueryCache,
  type QueryCacheConfig,
} from './lib/features/with-query-cache'
export {
  withMutationCache,
  type MutationCacheConfig,
} from './lib/features/with-mutation-cache'
