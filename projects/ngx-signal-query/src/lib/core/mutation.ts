import { type Signal, signal } from '@angular/core'
import {
  defer,
  from,
  retry as retryOperator,
  take,
  throwIfEmpty,
  timer,
  type Observable,
  type Subscription,
} from 'rxjs'

import { defaultRetryDelay, resolveRetryDelay, shouldRetry } from './retryer'
import type { RetryDelayValue, RetryValue } from './types'

/** Lifecycle status of a mutation: not yet run, running, succeeded, or failed. */
export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

/** Selects which mutations an operation applies to (e.g. `injectIsMutating`). */
export type MutationFilters = {
  /** Match mutations in this status. */
  status?: MutationStatus
}

/** Full state snapshot of a mutation (the reactive source behind {@link MutationResult}). */
export type MutationState<TData, TError, TVariables, TContext> = {
  /** Current {@link MutationStatus}. */
  status: MutationStatus
  /** Data resolved by the last successful run, or `undefined`. */
  data: TData | undefined
  /** Error of the last failed run, or `null`. */
  error: TError | null
  /** Variables passed to the most recent `mutate()` call. */
  variables: TVariables | undefined
  /** Value returned by `onMutate` for the current run. */
  context: TContext | undefined
  /** Number of failed attempts in the current run. */
  failureCount: number
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: TError | null
  /** Timestamp (ms) when the current run was submitted; `0` if never. */
  submittedAt: number
}

/**
 * Configuration for a mutation, passed to {@link injectMutation} /
 * {@link mutationOptions}. The hooks fire in order: `onMutate` →
 * (`onSuccess` | `onError`) → `onSettled`. The value returned by `onMutate`
 * is passed as `context` to the later hooks — handy for rollback.
 */
export type MutationOptions<TData, TError, TVariables, TContext> = {
  /** Performs the write; receives `mutate()`'s argument. Returns `Observable`/`Promise`. */
  mutationFn: (variables: TVariables) => Observable<TData> | Promise<TData>
  /** Retry policy. Defaults to no retry (writes are not idempotent). */
  retry?: RetryValue<TError>
  /** Delay between retries. See {@link RetryDelayValue}. */
  retryDelay?: RetryDelayValue<TError>
  /** Runs before `mutationFn`; its return value becomes `context` (e.g. for optimistic rollback). */
  onMutate?: (variables: TVariables) => TContext | undefined
  /** Runs after a successful `mutationFn`. */
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
  /** Runs after a failed `mutationFn`. */
  onError?: (
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
  /** Runs after success or error — for cleanup that should happen either way. */
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => void
}

/** Reactive result returned by {@link injectMutation}; state fields are signals. */
export type MutationResult<TData, TError, TVariables> = {
  /** Triggers the mutation with the given variables. */
  mutate: (variables: TVariables) => void
  /** Resets state back to `idle`, cancelling any in-flight run. */
  reset: () => void
  /** Data from the last successful run, or `undefined`. */
  data: Signal<TData | undefined>
  /** Error from the last failed run, or `null`. */
  error: Signal<TError | null>
  /** Variables from the most recent `mutate()` call. */
  variables: Signal<TVariables | undefined>
  /** Current {@link MutationStatus}. */
  status: Signal<MutationStatus>
  /** Whether the mutation has not been run yet. */
  isIdle: Signal<boolean>
  /** Whether the mutation is currently running. */
  isPending: Signal<boolean>
  /** Whether the last run succeeded. */
  isSuccess: Signal<boolean>
  /** Whether the last run failed. */
  isError: Signal<boolean>
  /** Consecutive failures in the current run. */
  failureCount: Signal<number>
  /** Error of the most recent failed attempt, or `null`. */
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
  readonly #state =
    signal<MutationState<TData, TError, TVariables, TContext>>(
      getInitialState(),
    )

  // `state` must follow `#state`: a public field can't precede the private
  // field it reads during initialization (field init order).
  // eslint-disable-next-line @typescript-eslint/member-ordering
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
