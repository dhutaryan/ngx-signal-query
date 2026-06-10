import { signal } from '@angular/core'
import { Observable, take, throwIfEmpty, type Subscription } from 'rxjs'

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error'

export type MutationState<TData, TError, TVariables> = {
  status: MutationStatus
  data: TData | undefined
  error: TError | null
  variables: TVariables | undefined
  submittedAt: number
}

export type MutationOptions<TData, TError, TVariables> = {
  mutationFn: (variables: TVariables) => Observable<TData>
}

function getInitialState<TData, TError, TVariables>(): MutationState<
  TData,
  TError,
  TVariables
> {
  return {
    status: 'idle',
    data: undefined,
    error: null,
    variables: undefined,
    submittedAt: 0,
  }
}

export class Mutation<TData = unknown, TError = Error, TVariables = void> {
  readonly #state = signal<MutationState<TData, TError, TVariables>>(
    getInitialState(),
  )
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null
  readonly #options: MutationOptions<TData, TError, TVariables>

  constructor(
    readonly mutationId: number,
    options: MutationOptions<TData, TError, TVariables>,
  ) {
    this.#options = options
  }

  execute(variables: TVariables): void {
    this.#state.set({
      status: 'pending',
      data: undefined,
      error: null,
      variables,
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
        next: (data) =>
          this.#state.update((state) => ({ ...state, status: 'success', data })),
        error: (error) =>
          this.#state.update((state) => ({ ...state, status: 'error', error })),
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
