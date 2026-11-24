import {
  type NgZone,
  type PendingTasks,
  type Signal,
  signal,
} from '@angular/core'
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
  merge,
  of,
  take,
  tap,
  throwIfEmpty,
  type Observable,
} from 'rxjs'

import type { MutationCache } from './mutation-cache'
import type { MutationCacheCallbacks } from './mutation-cache-callbacks'
import { countFailure, defaultRetryDelay, retryer } from './retryer'
import type { MutationMeta, RetryDelayValue, RetryValue } from './types'
import { deferred, isPromiseLike } from './utils'
import { requestOutsideZone } from './zone'

/** Lifecycle status of a mutation: not yet run, running (hooks included), succeeded, or failed. */
export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

/**
 * Names a mutation, the way a query key names a query: an array, from broad
 * to specific, such as `['todos', 'update']`. Filters match runs by it (see
 * {@link MutationFilters}).
 */
export type MutationKey = readonly unknown[]

/**
 * Selects the runs of mutations by their key and status.
 * {@link injectMutationState} takes it whole; {@link injectIsMutating} and
 * `isMutating()` take it without `status`, since they count pending runs.
 */
export type MutationFilters = {
  /**
   * Match the runs whose key starts with this key, or, with `exact`, equals
   * it. A run without a key doesn't match.
   */
  mutationKey?: MutationKey
  /** Require an exact key match instead of a prefix match. */
  exact?: boolean
  /** Match runs in this status. */
  status?: MutationStatus
}

/**
 * The state of one run of a mutation: an item that
 * {@link injectMutationState} lists without `select`, the `state` a cache
 * callback gets, and the source of what the signals of
 * {@link injectMutation} show for its latest run.
 */
export type MutationState<TData, TError, TVariables, TContext> = {
  /** The run's {@link MutationStatus}. */
  status: MutationStatus
  /** Data the run resolved with, or `undefined`. */
  data: TData | undefined
  /** Error the run failed with, or `null`. */
  error: TError | null
  /** Variables of the `mutate()` call that started the run. */
  variables: TVariables | undefined
  /** Value returned by `onMutate` for the run, or what its promise resolved to. */
  context: TContext | undefined
  /** Number of consecutive failures in the run. */
  failureCount: number
  /** Error of the run's most recent failure, or `null`. */
  failureReason: TError | null
  /** Timestamp (ms) when the run was submitted; `0` if never. */
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
 * the outcome: its error goes to the app's `ErrorHandler`, once, and the
 * hooks after it still run. Only a failing `onMutate` fails the mutation,
 * before the write is sent.
 */
export type MutationOptions<TData, TError, TVariables, TContext> = {
  /**
   * Performs the write; receives `mutate()`'s argument. Returns
   * `Observable`/`Promise`. With zone.js, it runs outside Angular's zone, as
   * `HttpClient` sends its requests, and the hooks run where `mutate()` was
   * called from: in the zone for a click handler.
   */
  mutationFn: (variables: TVariables) => Observable<TData> | Promise<TData>
  /**
   * Names the mutation, so that filters, such as those
   * {@link injectIsMutating} and {@link injectMutationState} take, can pick
   * out its runs (see {@link MutationFilters}). Each run keeps the key the
   * options give when `mutate()` is called.
   *
   * A key that changes, such as one with an input in it on a page that the
   * router keeps for the next item, resets the mutation the way `reset()`
   * does: the signals go back to `'idle'`, and a run in flight goes on and
   * fires its hooks. The callbacks passed to a `mutate()` aren't called if,
   * once its run is done, the options give another key than the call was
   * made under. A mutation without a key is never reset this way.
   */
  mutationKey?: MutationKey
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
  /**
   * What the app's cache callbacks, or the `select` of
   * {@link injectMutationState}, need to know about the mutation, such as
   * the queries to invalidate once it succeeds (see
   * {@link withMutationCache}). The library itself doesn't read it. Its type
   * is the `mutationMeta` that the app declares on {@link Register}, if it
   * does.
   */
  meta?: MutationMeta
}

/**
 * A run of a mutation, as a cache callback (see {@link withMutationCache})
 * and the `select` of {@link injectMutationState} get it: its state when
 * they're called, still `'pending'` while the hooks run, and the `meta` and
 * `mutationKey` of its options.
 */
export type MutationSnapshot<
  TData = unknown,
  TError = unknown,
  TVariables = unknown,
  TContext = unknown,
> = {
  /** The run's state when the callback or `select` is called. */
  readonly state: Readonly<MutationState<TData, TError, TVariables, TContext>>
  /** The `meta` of the mutation's options, if they have one. */
  readonly meta: MutationMeta | undefined
  /** The `mutationKey` of the mutation's options, if they have one. */
  // Optional, unlike meta: an app's test that builds a snapshot by hand
  // still compiles, the way it did before keys (see Mutation#snapshot for
  // the one that the callbacks and select get).
  readonly mutationKey?: MutationKey
}

/**
 * Callbacks for one call of `mutate()` or `mutateAsync()`, passed as its
 * second argument: the component's own reaction to that write, such as
 * closing a dialog. Each takes what the mutation's own hook of the same name
 * takes (see {@link MutationOptions}).
 *
 * They're called once the run is done: after the callbacks of
 * {@link withMutationCache} and the mutation's own hooks, with the outcome
 * already in the signals, and before the promise of `mutateAsync()` settles.
 * Every call gets its own, with its own outcome, also one that a later call
 * or `reset()` came after. None of them is called if, once the run is done,
 * the mutation's host, the component or service where {@link injectMutation}
 * ran, is destroyed, or the options give another `mutationKey` than the call
 * was made under (see {@link MutationOptions}); the mutation's own hooks
 * still run. Nothing waits
 * for a promise one returns. What one throws, or what such a promise rejects
 * with, goes to the app's `ErrorHandler`: the outcome and the other
 * callbacks stay as they are.
 */
export type MutateOptions<TData, TError, TVariables, TContext = unknown> = {
  /** Called with the data, the variables and the context. */
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown
  /** Called with the error, the variables and the context. */
  onError?: (
    error: TError,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown
  /**
   * Called with the data and `null`, or with `undefined` and the error, then
   * the variables and the context.
   */
  onSettled?: (
    data: TData | undefined,
    error: TError | null,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown
}

/** Reactive result returned by {@link injectMutation}; state fields are signals. */
export type MutationResult<TData, TError, TVariables, TContext = unknown> = {
  /**
   * Triggers the mutation with the given variables. A second argument adds
   * callbacks for this call alone (see {@link MutateOptions}). A failed write
   * doesn't throw: it shows in the signals. If the options function throws,
   * this throws its error before anything is sent.
   */
  mutate: (
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ) => void
  /**
   * Triggers the mutation as `mutate()` does, and returns a promise of that
   * run: it resolves with the data once the last hook is done, or rejects
   * with the error once `onError` and `onSettled` are. The callbacks passed
   * as a second argument are called before it settles, and nothing waits for
   * a promise they return. Unlike `mutate()`, a failure nobody catches
   * surfaces as an unhandled rejection, as with any async call. If the
   * options function throws, this throws its error at once, as `mutate()`
   * does, rather than returning a rejected promise.
   */
  mutateAsync: (
    variables: TVariables,
    options?: MutateOptions<TData, TError, TVariables, TContext>,
  ) => Promise<TData>
  /**
   * Resets the state to `idle`. It forgets the result and doesn't stop the
   * request: a run in flight finishes and fires its hooks and the callbacks
   * of its call.
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
  /** Error of the most recent failure, or `null`. */
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

/**
 * What a mutation is created with.
 *
 * @internal
 */
export type MutationConfig<TData, TError, TVariables, TContext> = {
  mutationId: number
  options: MutationOptions<TData, TError, TVariables, TContext>
  /**
   * The cache it lives in, which it only reaches to remove itself from once
   * it's done and nobody observes it.
   */
  cache: Pick<MutationCache, 'remove'>
  /**
   * The app's pending tasks: each run holds one until its last hook is done.
   */
  pendingTasks: Pick<PendingTasks, 'add'>
  /** Angular's zone, which its writes stay out of. */
  zone: Pick<NgZone, 'run' | 'runOutsideAngular'>
  /** Hands the error of a failing hook to the app's ErrorHandler. */
  reportError: (error: unknown) => void
  /** The app's callbacks for every mutation, which run before its own hooks. */
  callbacks: MutationCacheCallbacks
}

/** @internal */
export class Mutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
> {
  readonly mutationId: number

  readonly #state =
    signal<MutationState<TData, TError, TVariables, TContext>>(
      getInitialState(),
    )

  // `state` must follow `#state`: a public field can't precede the private
  // field it reads during initialization (field init order).
  // eslint-disable-next-line @typescript-eslint/member-ordering
  readonly state = this.#state.asReadonly()

  #observers = 0
  readonly #options: MutationOptions<TData, TError, TVariables, TContext>
  readonly #cache: Pick<MutationCache, 'remove'>
  readonly #pendingTasks: Pick<PendingTasks, 'add'>
  readonly #zone: Pick<NgZone, 'run' | 'runOutsideAngular'>
  readonly #reportError: (error: unknown) => void
  readonly #callbacks: MutationCacheCallbacks

  constructor({
    mutationId,
    options,
    cache,
    pendingTasks,
    zone,
    reportError,
    callbacks,
  }: MutationConfig<TData, TError, TVariables, TContext>) {
    this.mutationId = mutationId
    this.#options = options
    this.#cache = cache
    this.#pendingTasks = pendingTasks
    this.#zone = zone
    this.#reportError = reportError
    this.#callbacks = callbacks
  }

  /** The key of the run's options, which filters match it by. */
  get mutationKey(): MutationKey | undefined {
    return this.#options.mutationKey
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

  /**
   * Runs the mutation once. `variables` are passed straight to `mutationFn`.
   * Returns a promise of the run, settled as the state is, once its last hook
   * is done: with the data, or with the error. `mutateCallbacks` gives the
   * callbacks passed to the mutate() call that started the run, or nothing
   * once they're no longer wanted: the run asks for them once its outcome is
   * in, and calls them before its promise settles.
   */
  execute(
    variables: TVariables,
    mutateCallbacks?: () =>
      | MutateOptions<TData, TError, TVariables, TContext>
      | undefined,
  ): Promise<TData> {
    const run = deferred<TData>()
    // One of the app's pending tasks, held until the last hook is done:
    // Angular counts the app as busy meanwhile, so a server render and
    // whenStable() wait for the run, whatever its mutationFn sends the write
    // with. A run that outlives its component holds it all the same.
    const removeTask = this.#pendingTasks.add()

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

    // The outcome is fixed before the hooks that report it run: by the app's
    // onMutate, the mutation's own and then the write. Either onMutate calls
    // the write off when it fails. A hook that fails after that
    // can't turn a write that went through into an error. The run stays
    // pending, and in the cache, until its last hook is done. Nothing stops
    // it before that: the write has most likely reached the server (see
    // removeObserver), so clearing the cache only forgets the run.
    awaitHook(() => this.#callbacks.onMutate?.(variables, this.snapshot()))
      .pipe(
        // Only the mutation's own onMutate makes the context.
        concatMap(() => awaitHook(() => this.#options.onMutate?.(variables))),
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
        this.#state.update((state) => ({
          ...state,
          ...outcome,
          ...(outcome.status === 'error' && countFailure(state, outcome.error)),
        }))
        this.#disposeIfDone()
        // The signals show how it went by now, which the callbacks of the
        // call may read.
        this.#runMutateCallbacks(mutateCallbacks?.(), outcome, variables)

        if (outcome.status === 'success') {
          run.resolve(outcome.data)
        } else {
          run.reject(outcome.error)
        }

        // Last: whatever waits for the app to settle finds the outcome in.
        removeTask()
      })

    return run.promise
  }

  /**
   * What the app's callbacks and the `select` of
   * {@link injectMutationState} get of the run: its current state, and the
   * meta and key of its options. A run without a key gets no `mutationKey`
   * field, so its snapshot is what it was before keys: an app's test that
   * compares a whole snapshot still passes.
   */
  snapshot(): MutationSnapshot<TData, TError, TVariables, TContext> {
    const { meta, mutationKey } = this.#options

    return {
      state: this.state(),
      meta,
      ...(mutationKey && { mutationKey }),
    }
  }

  /** Sends the write, retrying as `retry` allows, and emits its data once. */
  #request(variables: TVariables): Observable<TData> {
    // Mutations default to no retry (not idempotent — a retried POST could
    // create a duplicate); opt in explicitly via options.retry.
    const retry = this.#options.retry ?? 0
    const retryDelay = this.#options.retryDelay ?? defaultRetryDelay

    // Each attempt calls mutationFn afresh (a Promise is one-shot, so a retry
    // needs a new one) outside Angular's zone, and its outcome comes back to
    // where mutate() was called from (see requestOutsideZone): with zone.js,
    // what the write waits on mustn't keep the app from counting as stable,
    // and the hooks run where they would without this. The task the run holds
    // keeps the app busy until its last hook is done all the same.
    return retryer<TData, TError>({
      attempt: () =>
        requestOutsideZone(this.#zone, () =>
          this.#options.mutationFn(variables),
        ).pipe(take(1)),
      retry,
      retryDelay,
      onFail: (failureCount, failureReason) =>
        this.#state.update((state) => ({
          ...state,
          failureCount,
          failureReason,
        })),
    }).pipe(
      throwIfEmpty(
        () => new Error('Mutation function completed without emitting a value'),
      ),
    )
  }

  /**
   * Runs the hooks that report an outcome, in order: onSuccess or onError,
   * then onSettled, the app's callback before the mutation's own hook of the
   * same name. A hook that returns a promise holds the next one until it
   * settles. One that fails is reported, and the next still runs.
   */
  #runHooks(
    outcome: Outcome<TData, TError>,
    variables: TVariables,
  ): Observable<never> {
    const { context } = this.state()
    // One snapshot serves all four hooks: the run's state doesn't change
    // until they're done, since the outcome is written after them.
    const mutation = this.snapshot()

    return concat(
      runHook(this.#reportError, () =>
        outcome.status === 'success'
          ? this.#callbacks.onSuccess?.(
              outcome.data,
              variables,
              context,
              mutation,
            )
          : this.#callbacks.onError?.(
              outcome.error,
              variables,
              context,
              mutation,
            ),
      ),
      runHook(this.#reportError, () =>
        outcome.status === 'success'
          ? this.#options.onSuccess?.(outcome.data, variables, context)
          : this.#options.onError?.(outcome.error, variables, context),
      ),
      runHook(this.#reportError, () =>
        this.#callbacks.onSettled?.(
          outcome.data,
          outcome.error,
          variables,
          context,
          mutation,
        ),
      ),
      runHook(this.#reportError, () =>
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
   * Calls the callbacks of the mutate() call that started the run, in order:
   * onSuccess or onError, then onSettled. Each is called once the one before
   * it returns: nothing waits for a promise one returns. One that fails is
   * reported, and the next is still called.
   */
  #runMutateCallbacks(
    callbacks: MutateOptions<TData, TError, TVariables, TContext> | undefined,
    outcome: Outcome<TData, TError>,
    variables: TVariables,
  ): void {
    if (!callbacks) return

    const { context } = this.state()

    // Not unsubscribed: it ends by itself, at once or, for a callback that
    // returns a promise, once that settles, so a rejection is still
    // reported. Unsubscribing wouldn't stop the promise, only lose its error.
    merge(
      runHook(this.#reportError, () =>
        outcome.status === 'success'
          ? callbacks.onSuccess?.(outcome.data, variables, context)
          : callbacks.onError?.(outcome.error, variables, context),
      ),
      runHook(this.#reportError, () =>
        callbacks.onSettled?.(outcome.data, outcome.error, variables, context),
      ),
    ).subscribe()
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

// Runs a hook or a callback that reports an outcome. Only its end matters:
// what it returns is dropped, and an error it throws goes to reportError,
// which hands it to the app's ErrorHandler and never throws: the run carries
// on.
function runHook(
  reportError: (error: unknown) => void,
  hook: () => unknown,
): Observable<never> {
  return awaitHook(hook).pipe(
    ignoreElements(),
    catchError((error: unknown) => {
      reportError(error)

      return EMPTY
    }),
  )
}
