import { signal } from '@angular/core'
import { Observable, Subscription, take } from 'rxjs'

import { QueryKey, QueryStatus } from './types'

export interface QueryState<TData, TError = Error> {
  data: TData | undefined
  status: QueryStatus
  error: TError | null
  isFetching: boolean
  updatedAt: number
}

export class Query<TData, TError = Error> {
  readonly #state = signal<QueryState<TData, TError>>({
    data: undefined,
    status: 'pending',
    error: null,
    isFetching: false,
    updatedAt: 0,
  })
  readonly state = this.#state.asReadonly()

  #subscription: Subscription | null = null

  constructor(
    readonly key: QueryKey,
    readonly serializedKey: string,
  ) {}

  fetch(queryFn: () => Observable<TData>): void {
    if (this.#subscription && !this.#subscription.closed) return

    this.#state.update((state) => ({ ...state, isFetching: true }))

    this.#subscription = queryFn()
      .pipe(take(1))
      .subscribe({
        next: (data) =>
          this.#state.set({
            data,
            status: 'success',
            error: null,
            isFetching: false,
            updatedAt: Date.now(),
          }),
        error: (err) =>
          this.#state.update((state) => ({
            ...state,
            status: 'error',
            error: err,
            isFetching: false,
          })),
      })
  }

  setData(data: TData): void {
    this.#state.update((state) => ({
      ...state,
      data,
      status: 'success',
      updatedAt: Date.now(),
    }))
  }

  invalidate(): void {
    this.#state.update((state) => ({ ...state, updatedAt: 0 }))
  }

  isStale(staleTime: number): boolean {
    return Date.now() - this.state().updatedAt > staleTime
  }

  cancel(): void {
    this.#subscription?.unsubscribe()
    this.#subscription = null
  }
}
