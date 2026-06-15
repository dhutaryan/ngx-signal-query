import { signal, Signal } from '@angular/core'
import {
  defer,
  from,
  Observable,
  retry as retryOperator,
  take,
  throwIfEmpty,
  timer,
  type Subscription,
} from 'rxjs'

import {
  defaultRetryDelay,
  resolveRetryDelay,
  shouldRetry,
} from './retryer'
import { RetryDelayValue, RetryValue } from './types'

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

export type MutationFilters = {
  status?: MutationStatus
}

export type MutationState<TData, TError, TVariables, TContext> = {
  status: MutationStatus
  data: TData | undefined
  error: TError | null
  variables: TVariables | undefined
  context: TContext | undefined
  failureCount: number
  failureReason: TError | null
  submittedAt: number
}

export type MutationOptions<TData, TError, TVariables, TContext> = {
  mutationFn: (variables: TVariables) => Observable<TData> | Promise<TData>
  retry?: RetryValue<TError>
  retryDelay?: RetryDelayValue<TError>
  onMutate?: (variables: TVariables) => TContext | undefined
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
  onError?: (
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
}

export type MutationResult<TData, TError, TVariables> = {
  mutate: (variables: TVariables) => void
  reset: () => void
  data: Signal<TData | undefined>
  error: Signal<TError | null>
  variables: Signal<TVariables | undefined>
  status: Signal<MutationStatus>
  isIdle: Signal<boolean>
  isPending: Signal<boolean>
  isSuccess: Signal<boolean>
  isError: Signal<boolean>
  failureCount: Signal<number>
  failureReason: Signal<TError | null>
}

function getInitialState<TData, TError, TVariables, TContext>(): MutationState<
  TData,
  TError,
  TVariables,
  TContext
> {
  return {
    status: 'idle',
    data: undefined,
    error: null,
    variables: undefined,
    context: undefined,
    failureCount: 0,
    failureReason: null,
    submittedAt: 0,
  }
}

export class Mutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
> {
  readonly #state = signal<MutationState<TData, TError, TVariables, TContext>>(
    getInitialState(),
  )
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null
  readonly #options: MutationOptions<TData, TError, TVariables, TContext>

  constructor(
    readonly mutationId: number,
    options: MutationOptions<TData, TError, TVariables, TContext>,
  ) {
    this.#options = options
  }

  execute(variables: TVariables): void {
    const context = this.#options.onMutate?.(variables)
    // Mutations default to no retry (not idempotent — a retried POST could
    // create a duplicate); opt in explicitly via options.retry.
    const retry = this.#options.retry ?? 0
    const retryDelay = this.#options.retryDelay ?? defaultRetryDelay

    this.#state.set({
      status: 'pending',
      data: undefined,
      error: null,
      variables,
      context,
      failureCount: 0,
      failureReason: null,
      submittedAt: Date.now(),
    })

    // defer + from: normalize Observable/Promise and re-invoke mutationFn on
    // each retry (a Promise is one-shot, so retry must produce a fresh one).
    this.#subscription = defer(() => from(this.#options.mutationFn(variables)))
      .pipe(
        take(1),
        retryOperator({
          delay: (error, retryCount) => {
            this.#state.update((state) => ({
              ...state,
              failureCount: retryCount,
              failureReason: error as TError,
            }))

            const attemptIndex = retryCount - 1
            if (!shouldRetry(retry, attemptIndex, error as TError)) throw error
            return timer(
              resolveRetryDelay(retryDelay, attemptIndex, error as TError),
            )
          },
        }),
        throwIfEmpty(
          () =>
            new Error('Mutation function completed without emitting a value'),
        ),
      )
      .subscribe({
        next: (data) => {
          this.#state.update((state) => ({ ...state, status: 'success', data }))
          this.#options.onSuccess?.(data, variables, context)
          this.#options.onSettled?.(data, null, variables, context)
        },
        error: (error: TError) => {
          this.#state.update((state) => ({ ...state, status: 'error', error }))
          this.#options.onError?.(error, variables, context)
          this.#options.onSettled?.(undefined, error, variables, context)
        },
      })
  }

  reset(): void {
    this.cancel()
    this.#state.set(getInitialState())
  }

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null
  }
}
