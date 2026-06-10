import { signal, Signal } from '@angular/core'
import { Observable, take, throwIfEmpty, type Subscription } from 'rxjs'

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

export type MutationState<TData, TError, TVariables, TContext> = {
  status: MutationStatus
  data: TData | undefined
  error: TError | null
  variables: TVariables | undefined
  context: TContext | undefined
  submittedAt: number
}

export type MutationOptions<TData, TError, TVariables, TContext> = {
  mutationFn: (variables: TVariables) => Observable<TData>
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

    this.#state.set({
      status: 'pending',
      data: undefined,
      error: null,
      variables,
      context,
      submittedAt: Date.now(),
    })

    this.#subscription = this.#options
      .mutationFn(variables)
      .pipe(
        take(1),
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
