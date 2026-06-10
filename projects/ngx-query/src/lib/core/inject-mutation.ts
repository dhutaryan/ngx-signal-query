import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  inject,
  Injector,
  runInInjectionContext,
} from '@angular/core'

import { MutationCache } from './mutation-cache'
import { MutationOptions, MutationResult } from './mutation'

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
    const cache = inject(MutationCache)
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
    }
  })
}
