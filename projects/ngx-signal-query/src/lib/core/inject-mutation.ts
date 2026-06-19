import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  inject,
  Injector,
  runInInjectionContext,
} from '@angular/core'

import { QueryClient } from './query-client'
import { MutationOptions, MutationResult } from './mutation'

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
    const mutation = cache.build(optionsFn())

    inject(DestroyRef).onDestroy(() => {
      mutation.cancel()
      cache.remove(mutation)
    })

    return {
      mutate: (variables) => mutation.execute(variables),
      reset: () => mutation.reset(),
      data: computed(() => mutation.state().data),
      error: computed(() => mutation.state().error as TError | null),
      variables: computed(() => mutation.state().variables),
      status: computed(() => mutation.state().status),
      isIdle: computed(() => mutation.state().status === 'idle'),
      isPending: computed(() => mutation.state().status === 'pending'),
      isSuccess: computed(() => mutation.state().status === 'success'),
      isError: computed(() => mutation.state().status === 'error'),
      failureCount: computed(() => mutation.state().failureCount),
      failureReason: computed(
        () => mutation.state().failureReason as TError | null,
      ),
    }
  })
}
