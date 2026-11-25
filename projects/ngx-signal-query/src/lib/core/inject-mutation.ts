import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core'

import { QueryClient } from './query-client'
import {
  type MutateOptions,
  type Mutation,
  type MutationKey,
  type MutationOptions,
  type MutationResult,
  getInitialState,
} from './mutation'
import { hashKey } from './utils'

/**
 * Creates a mutation for imperative writes (create/update/delete) and exposes
 * its state as signals.
 *
 * Unlike queries, a mutation does not run on its own — call `mutate(variables)`
 * to trigger `mutationFn`.
 *
 * The `onMutate` / `onSuccess` / `onError` / `onSettled` lifecycle hooks make
 * optimistic updates and cache invalidation straightforward. A hook may
 * return a promise; the mutation stays pending until it settles. Mutations do
 * not retry by default (a retried write is not idempotent); opt in via
 * `options.retry`. Whatever of `retry`, `retryDelay` and the `onSuccess` /
 * `onError` / `onSettled` hooks a mutation leaves unset comes from
 * {@link withDefaultOptions}.
 *
 * `mutateAsync(variables)` runs it the same way as `mutate()` and returns a
 * promise of the run's data. Both take callbacks for that call alone as a
 * second argument, for the component's own reaction to the write (see
 * {@link MutateOptions}).
 *
 * `mutate()` and `mutateAsync()` call `optionsFn` each time; if it throws,
 * they throw its error before anything is sent, and the signals keep showing
 * the run before. They and `reset()` are safe to call from an effect: none
 * makes the effect depend on what it reads, such as the options or the
 * previous run.
 *
 * Bound to the current injection context. Destroying it doesn't cancel a run
 * in flight: the write has most likely reached the server, so the run
 * finishes and fires its hooks. A `mutate()` that comes after that, say from
 * a timer, runs and fires its hooks too. The callbacks of a call are the
 * exception: none of them is called once the context is destroyed, or once
 * the options give another `mutationKey` than the call was made under. A key
 * that changes resets the mutation, the way `reset()` does (see
 * {@link MutationOptions}).
 *
 * From `mutate()` until its last hook is done, a run keeps the app busy,
 * whether its component is still there or not: a server render and
 * `whenStable()` wait for it.
 *
 * Must run in an injection context, or be given an explicit `injector`.
 *
 * @typeParam TData - Type of the data resolved by `mutationFn`.
 * @typeParam TError - Type of the error thrown by `mutationFn`.
 * @typeParam TVariables - Type of the argument passed to `mutate()`.
 * @typeParam TContext - Type returned by `onMutate`, passed to later hooks.
 * @param optionsFn - Factory returning the {@link MutationOptions}, called on
 *   every `mutate()` and `mutateAsync()`. With a `mutationKey`, it's also
 *   called outside them, to follow the key while a run with a key is shown.
 *   An error it throws then isn't reported: `mutate()` reports it.
 * @param options - Optional `injector` to use outside an injection context.
 * @returns A {@link MutationResult}: `mutate()`, `mutateAsync()`, `reset()`,
 *   and state signals (`status`, `data`, `error`, `isPending`, …).
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
): MutationResult<TData, TError, TVariables, TContext> {
  if (!options?.injector) assertInInjectionContext(injectMutation)

  const injector = options?.injector ?? inject(Injector)

  return runInInjectionContext(injector, () => {
    const client = inject(QueryClient)
    const cache = client.getMutationCache()

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
    // itself from the cache once it settles with no observer. A run started
    // after the destroy isn't observed to begin with (see start()).
    //
    // TODO: read DestroyRef.destroyed instead of this flag once the minimum
    // supported Angular is 20.1, where it became public.
    let destroyed = false

    inject(DestroyRef).onDestroy(() => {
      destroyed = true
      untracked(current)?.removeObserver()
    })

    // "Forget the result", not "stop the request": the signals go back to
    // idle, and a run still in flight keeps going and fires its hooks, so the
    // cache stays in step with the server. Cancelling could not un-send the
    // write anyway, it could only hide the fact that it happened.
    const forget = (): void => {
      current()?.removeObserver()

      current.set(null)
    }

    // The key the options give now. None while the options function throws,
    // such as while the item in the key is still loading: only mutate()
    // reports that error.
    const keyNow = (): MutationKey | undefined => {
      try {
        return optionsFn().mutationKey
      } catch {
        return undefined
      }
    }

    // Whether the host has moved on from the key that a run was started
    // with: its options give another key now, such as on a page that the
    // router keeps for the next todo. The host hasn't moved on from a run
    // without a key, nor while its options give none.
    const movedOn = (
      run: Mutation<TData, TError, TVariables, TContext>,
    ): boolean => {
      if (!run.mutationKey) return false

      const key = keyNow()

      return key !== undefined && hashKey(key) !== hashKey(run.mutationKey)
    }

    // What the signals below show: the run in `current`, unless the host has
    // moved on from its key. Checked here, as the signals are read, so that
    // nothing sees the run of the item before once the key has changed, not
    // even a template or an effect that runs before the effect below. For a
    // run without a key, the options aren't read here, so a mutation without
    // one reads them on mutate() only.
    const state = computed(() => {
      const run = current()

      return run && !movedOn(run)
        ? run.state()
        : getInitialState<TData, TError, TVariables, TContext>()
    })

    // Once the key has changed, the run of the item before is forgotten, the
    // way reset() does, so that it no longer counts as shown: it's let go,
    // and leaves the cache once done. Made with the mutation, not on
    // mutate(): a mutate() can come while the host is torn down, when no
    // effect can be made for it any more.
    effect(() => {
      const shown = current()

      if (shown && movedOn(shown)) untracked(forget)
    })

    // mutate(), mutateAsync() and reset() run untracked, as the QueryClient's
    // methods do. A call made from an effect mustn't make the effect depend on
    // what they read to do their job: the previous run's state, the options,
    // or what onMutate and mutationFn read. Otherwise a change to any of them
    // re-runs the effect, and the effect repeats the call.
    //
    // Starts a run for mutate() and mutateAsync(), makes it the run the
    // signals below follow, and returns its promise.
    const start = (
      variables: TVariables,
      callbacks?: MutateOptions<TData, TError, TVariables, TContext>,
    ): Promise<TData> =>
      untracked(() => {
        // Options are read per call, so a signal used in them stays live.
        // First, so that if optionsFn throws, nothing has changed yet: the
        // previous run is still observed, and the signals keep following it.
        const options = client.defaultMutationOptions(optionsFn())

        // Stop observing the previous run. It isn't cancelled — if it's
        // still in flight it finishes and fires its hooks; it just no longer
        // feeds the signals below.
        current()?.removeObserver()

        const run = cache.build(options)

        // Once the host is destroyed, nothing will remove an observer added
        // now, and a run with one never leaves the cache. So a run started
        // after that isn't observed: it still runs and the signals still show
        // it, but it drops out of the cache once it settles, as a run in
        // flight at the destroy does.
        if (!destroyed) run.addObserver()

        current.set(run)

        // The callbacks of the call are the host's reaction to the write, so
        // they're called only if, once the run lands, the host is still there
        // and still shows the key that the call was made for. The hooks run
        // either way: they keep the cache in step with the server.
        return run.execute(variables, () => {
          // A call without callbacks has nothing to check, so the options
          // aren't read again for it.
          if (!callbacks || destroyed) return undefined

          // Untracked: the write may land inside another effect, which
          // mustn't come to depend on the options.
          return untracked(() => movedOn(run)) ? undefined : callbacks
        })
      })

    return {
      // The outcome shows in the signals; a failure mustn't surface as an
      // unhandled rejection too.
      mutate: (variables, callbacks) => {
        start(variables, callbacks).catch(() => undefined)
      },
      mutateAsync: start,
      reset: () => untracked(forget),
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
