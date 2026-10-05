import { type Signal, signal } from '@angular/core'
import {
  catchError,
  concat,
  concatMap,
  defer,
  EMPTY,
  endWith,
  from,
  ignoreElements,
  map,
  of,
  retry as retryOperator,
  take,
  tap,
  throwIfEmpty,
  timer,
  type Observable,
  type Subscription,
} from 'rxjs'

import type { MutationCache } from './mutation-cache'
import { defaultRetryDelay, resolveRetryDelay, shouldRetry } from './retryer'
import type { RetryDelayValue, RetryValue } from './types'
import { isPromiseLike } from './utils'

/** Lifecycle status of a mutation: not yet run, running (hooks included), succeeded, or failed. */
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
  /** Value returned by `onMutate` for the current run, or what its promise resolved to. */
  context: TContext | undefined
  /** Number of consecutive failed attempts in the current run. */
  failureCount: number
  /** Error of the most recent failed attempt, or `null`. */
  failureReason: TError | null
  /** Timestamp (ms) when the current run was submitted; `0` if never. */
  submittedAt: number
}

/**
 * What a run's write came to: its data, or the error it failed with. A
 * success also clears the failed attempts that came before it.
 */
type Outcome<TData, TError> =
  | {
      status: 'success'
      data: TData
      error: null
      failureCount: 0
      failureReason: null
    }
  | { status: 'error'; data: undefined; error: TError }

/**
 * Configuration for a mutation, passed to {@link injectMutation} /
 * {@link mutationOptions}. The hooks fire in order: `onMutate` →
 * (`onSuccess` | `onError`) → `onSettled`. The value returned by `onMutate`
 * is passed as `context` to the later hooks — handy for rollback.
 *
 * A hook may return a promise: the next step waits for it, and the mutation
 * stays pending until the last hook is done. A hook that fails doesn't change
 * the outcome: its error is rethrown as an unhandled rejection, and the hooks
 * after it still run. Only a failing `onMutate` fails the mutation, before the
 * write is sent.
 */
export type MutationOptions<TData, TError, TVariables, TContext> = {
  /** Performs the write; receives `mutate()`'s argument. Returns `Observable`/`Promise`. */
  mutationFn: (variables: TVariables) => Observable<TData> | Promise<TData>
  /** Retry policy. Defaults to no retry (writes are not idempotent). */
  retry?: RetryValue<TError>
  /** Delay between retries. See {@link RetryDelayValue}. */
  retryDelay?: RetryDelayValue<TError>
  /**
   * Runs before `mutationFn`; what it returns becomes `context` (e.g. for
   * optimistic rollback). If it returns a promise, the write waits for it,
   * and `context` is what it resolves to. If it fails, the mutation fails
   * without sending the write.
   */
  onMutate?: (
    variables: TVariables,
  ) => Promise<TContext | undefined> | TContext | undefined
  /** Runs after a successful `mutationFn`. If it returns a promise, `onSettled` waits for it. */
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => Promise<unknown> | unknown
  /** Runs after a failed `mutationFn` or `onMutate`. If it returns a promise, `onSettled` waits for it. */
  onError?: (
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
  ) => Promise<unknown> | unknown
  /**
   * Runs after success or error — for cleanup that should happen either way.
   * If it returns a promise, the mutation stays pending until it settles.
   */
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => Promise<unknown> | unknown
}

/** Reactive result returned by {@link injectMutation}; state fields are signals. */
export type MutationResult<TData, TError, TVariables> = {
  /** Triggers the mutation with the given variables. */
  mutate: (variables: TVariables) => void
  /**
   * Resets the state to `idle`. It forgets the result and doesn't stop the
   * request: a run in flight finishes and fires its hooks.
   */
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
  /** Whether the mutation is running, its hooks included. */
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

/** @internal */
export function getInitialState<
  TData,
  TError,
  TVariables,
  TContext,
>(): MutationState<TData, TError, TVariables, TContext> {
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

/** @internal */
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
  #observers = 0
  readonly #options: MutationOptions<TData, TError, TVariables, TContext>
  readonly #cache: MutationCache

  constructor(
    readonly mutationId: number,
    options: MutationOptions<TData, TError, TVariables, TContext>,
    cache: MutationCache,
  ) {
    this.#options = options
    this.#cache = cache
  }

  get observerCount(): number {
    return this.#observers
  }

  addObserver(): void {
    this.#observers++
  }

  /**
   * Unlike a query, losing its last observer does not cancel a mutation: the
   * write has most likely reached the server already, so it must be allowed to
   * land and run its hooks. It is only dropped from the cache once it has both
   * settled and been abandoned — whichever of the two happens last.
   */
  removeObserver(): void {
    if (this.#observers === 0) return

    this.#observers--

    this.#disposeIfDone()
  }

  /** Runs the mutation once. `variables` are passed straight to `mutationFn`. */
  execute(variables: TVariables): void {
    this.#state.set({
      status: 'pending',
      data: undefined,
      error: null,
      variables,
      context: undefined,
      failureCount: 0,
      failureReason: null,
      submittedAt: Date.now(),
    })

    // The outcome is fixed before the hooks that report it run: by onMutate,
    // whose failure calls off the write, then by the write. A hook that fails
    // after that can't turn a write that went through into an error. The run
    // stays pending, and in the cache, until its last hook is done.
    this.#subscription = awaitHook(() => this.#options.onMutate?.(variables))
      .pipe(
        tap((context) =>
          this.#state.update((state) => ({ ...state, context })),
        ),
        concatMap(() => this.#request(variables)),
        map(
          (data): Outcome<TData, TError> => ({
            status: 'success',
            data,
            error: null,
            failureCount: 0,
            failureReason: null,
          }),
        ),
        catchError((error: TError) =>
          of<Outcome<TData, TError>>({
            status: 'error',
            data: undefined,
            error,
          }),
        ),
        concatMap((outcome) =>
          this.#runHooks(outcome, variables).pipe(endWith(outcome)),
        ),
      )
      .subscribe((outcome) => {
        this.#state.update((state) => ({ ...state, ...outcome }))
        this.#disposeIfDone()
      })
  }

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null
  }

  /** Sends the write, retrying as `retry` allows, and emits its data once. */
  #request(variables: TVariables): Observable<TData> {
    // Mutations default to no retry (not idempotent — a retried POST could
    // create a duplicate); opt in explicitly via options.retry.
    const retry = this.#options.retry ?? 0
    const retryDelay = this.#options.retryDelay ?? defaultRetryDelay

    // defer + from: normalize Observable/Promise and re-invoke mutationFn on
    // each retry (a Promise is one-shot, so retry must produce a fresh one).
    return defer(() => from(this.#options.mutationFn(variables))).pipe(
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
        () => new Error('Mutation function completed without emitting a value'),
      ),
    )
  }

  /**
   * Runs the hooks that report an outcome, in order: onSuccess or onError,
   * then onSettled. A hook that returns a promise holds the next one until it
   * settles. One that fails is reported, and the next still runs.
   */
  #runHooks(
    outcome: Outcome<TData, TError>,
    variables: TVariables,
  ): Observable<never> {
    const { context } = this.state()

    return concat(
      runHook(() =>
        outcome.status === 'success'
          ? this.#options.onSuccess?.(outcome.data, variables, context)
          : this.#options.onError?.(outcome.error, variables, context),
      ),
      runHook(() =>
        this.#options.onSettled?.(
          outcome.data,
          outcome.error,
          variables,
          context,
        ),
      ),
    )
  }

  /**
   * A run nobody observes any more, and which is no longer in flight, has
   * nothing left to report — drop it. Called from both ends, since the two
   * conditions can be met in either order: a superseded run may settle later,
   * and a settled run may be abandoned later.
   */
  #disposeIfDone(): void {
    if (this.#observers > 0) return
    if (this.state().status === 'pending') return

    this.#cache.remove(this)
  }
}

// Calls a hook and waits for the promise it returns, if any. Anything else
// it returns doesn't wait, so a run whose mutationFn emits synchronously
// still settles inside mutate().
function awaitHook<T>(hook: () => T | PromiseLike<T>): Observable<T> {
  return defer(() => {
    const result = hook()

    return isPromiseLike(result) ? from(result) : of(result)
  })
}

// Runs a hook that reports an outcome. Only its end matters: what it
// returns is dropped, and an error it throws is rethrown as an unhandled
// rejection, so the app's error handling sees it while the run carries on.
function runHook(hook: () => unknown): Observable<never> {
  return awaitHook(hook).pipe(
    ignoreElements(),
    catchError((error: unknown) => {
      void Promise.reject(error)

      return EMPTY
    }),
  )
}
