import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core'

import { QueryClient } from './query-client'
import {
  type Mutation,
  type MutationOptions,
  type MutationResult,
  getInitialState,
} from './mutation'

/**
 * Creates a mutation for imperative writes (create/update/delete) and exposes
 * its state as signals.
 *
 * Unlike queries, a mutation does not run on its own — call `mutate(variables)`
 * to trigger `mutationFn`. The `onMutate` / `onSuccess` / `onError` /
 * `onSettled` lifecycle hooks make optimistic updates and cache invalidation
 * straightforward. Mutations do not retry by default (a retried write is not
 * idempotent); opt in via `options.retry`. Bound to the current injection
 * context and cancelled when that context is destroyed.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `mutationFn`.
 * @typeParam TError - Type of the error thrown by `mutationFn`.
 * @typeParam TVariables - Type of the argument passed to `mutate()`.
 * @typeParam TContext - Type returned by `onMutate`, passed to later hooks.
 * @param optionsFn - Factory returning the {@link MutationOptions}.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link MutationResult}: `mutate()`, `reset()`, and state signals
 *   (`status`, `data`, `error`, `isPending`, …).
 *
 * @example
 * ```ts
 * const client = injectQueryClient()
 *
 * const addTodo = injectMutation(() => ({
 *   mutationFn: (title: string) => http.post<Todo>('/api/todos', { title }),
 *   onSuccess: () => client.invalidateQueries({ queryKey: ['todos'] }),
 * }))
 *
 * // <button (click)="addTodo.mutate('Buy milk')" [disabled]="addTodo.isPending()">Add</button>
 * ```
 */
export function injectMutation<
  TData,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  optionsFn: () => MutationOptions<TData, TError, TVariables, TContext>,
  options?: { injector?: Injector },
): MutationResult<TData, TError, TVariables> {
  if (!options?.injector) assertInInjectionContext(injectMutation)

  const injector = options?.injector ?? inject(Injector)

  return runInInjectionContext(injector, () => {
    const cache = inject(QueryClient).getMutationCache()

    // Every mutate() builds its own Mutation. Sharing one across calls meant a
    // second call overwrote the first's subscription (orphaning the request)
    // and its state (so the slower run, not the latest one, decided the result).
    const current = signal<Mutation<
      TData,
      TError,
      TVariables,
      TContext
    > | null>(null)

    // Detaching is all we do on destroy. A run still in flight keeps going —
    // the write has most likely reached the server already, so cancelling it
    // would only skip onSuccess and leave the cache out of sync. It drops
    // itself from the cache once it settles with nobody watching.
    inject(DestroyRef).onDestroy(() => untracked(current)?.removeObserver())

    const state = computed(
      () =>
        current()?.state() ??
        getInitialState<TData, TError, TVariables, TContext>(),
    )

    return {
      mutate: (variables) => {
        // Stop observing the previous run. It isn't cancelled — if it's still
        // in flight it finishes and fires its hooks; it just no longer feeds
        // the signals below.
        untracked(current)?.removeObserver()

        // Options are read per call, so a signal used in them stays live.
        const run = cache.build(optionsFn())

        run.addObserver()
        current.set(run)
        run.execute(variables)
      },
      reset: () => {
        // "Forget the result", not "stop the request". A run still in flight
        // keeps going and fires its hooks, so the cache stays in step with the
        // server — cancelling could not un-send the write anyway, it could only
        // hide the fact that it happened.
        untracked(current)?.removeObserver()

        current.set(null)
      },
      data: computed(() => state().data),
      error: computed(() => state().error as TError | null),
      variables: computed(() => state().variables),
      status: computed(() => state().status),
      isIdle: computed(() => state().status === 'idle'),
      isPending: computed(() => state().status === 'pending'),
      isSuccess: computed(() => state().status === 'success'),
      isError: computed(() => state().status === 'error'),
      failureCount: computed(() => state().failureCount),
      failureReason: computed(() => state().failureReason as TError | null),
    }
  })
}
