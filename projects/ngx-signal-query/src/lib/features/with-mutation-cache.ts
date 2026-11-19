import { MUTATION_CACHE_CONFIG } from '../core/injection-tokens'
import type { MutationSnapshot } from '../core/mutation'
import {
  type QueryClientFeature,
  QueryClientFeatureKind,
  queryClientFeature,
} from './feature'

/**
 * Callbacks for every mutation, set with {@link withMutationCache}. Each
 * runs before the mutation's own hook of the same name, or the default one
 * (see {@link withDefaultOptions}), and gets the run as a
 * {@link MutationSnapshot}. Everything else is typed `unknown`: one callback
 * serves every mutation, whatever its types.
 */
export type MutationCacheConfig = {
  /**
   * Runs when a run starts, with its variables. If it fails, the run fails
   * without sending the write. What it returns isn't the run's `context`:
   * only the mutation's own `onMutate` makes that.
   */
  onMutate?: (
    variables: unknown,
    mutation: MutationSnapshot,
  ) => Promise<unknown> | unknown
  /** Runs once the write succeeds, with its data, the variables and the context. */
  onSuccess?: (
    data: unknown,
    variables: unknown,
    context: unknown,
    mutation: MutationSnapshot,
  ) => Promise<unknown> | unknown
  /** Runs once the write or an `onMutate` fails, with the error, the variables and the context. */
  onError?: (
    error: unknown,
    variables: unknown,
    context: unknown,
    mutation: MutationSnapshot,
  ) => Promise<unknown> | unknown
  /**
   * Runs after `onSuccess` or `onError`: with the data and `null`, or with
   * `undefined` and the error.
   */
  onSettled?: (
    data: unknown,
    error: unknown,
    variables: unknown,
    context: unknown,
    mutation: MutationSnapshot,
  ) => Promise<unknown> | unknown
}

/**
 * Feature for {@link provideQueryClient} that sets callbacks for every
 * mutation. A run calls each one before the mutation's own hook of the same
 * name, or before the default one (see {@link withDefaultOptions}): `onMutate`
 * when it starts, then, once the write is done, `onSuccess` or `onError`, then
 * `onSettled`. Unlike a default hook, a mutation's own hook doesn't replace
 * them.
 *
 * A callback that returns a promise holds the run until it settles, as a
 * mutation's own hook does: the mutation stays pending until its last hook
 * is done. If `onMutate` fails, the run fails without sending the write, and
 * the mutation's own `onMutate` doesn't run. An error any other callback
 * throws, or a promise it returns that rejects, goes to the app's
 * `ErrorHandler`: the outcome stands, and the next hook still runs.
 *
 * They run in the injection context of the injector that provides the
 * client, so they can call `inject()` before their first `await`; once the
 * app is torn down, they no longer run.
 *
 * @param config - The {@link MutationCacheConfig} callbacks.
 * @returns A {@link QueryClientFeature} to pass to {@link provideQueryClient}.
 *
 * @example
 * ```ts
 * provideQueryClient(
 *   withMutationCache({
 *     onError: (error) => inject(ErrorHandler).handleError(error),
 *   }),
 * )
 * ```
 */
export function withMutationCache(
  config: MutationCacheConfig,
): QueryClientFeature<QueryClientFeatureKind.MutationCache> {
  return queryClientFeature(QueryClientFeatureKind.MutationCache, [
    { provide: MUTATION_CACHE_CONFIG, useValue: config },
  ])
}
